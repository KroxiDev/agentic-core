import path from "node:path";
import ts from "typescript";

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);
function scriptKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ts", ".mts", ".cts"].includes(extension)) return ts.ScriptKind.TS;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}
function symbolName(node, sourceFile) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteralLike(node.name)) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
    if (ts.isPropertyAssignment(node.parent) && node.parent.name) return node.parent.name.getText(sourceFile);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `<anonymous@${line + 1}:${character + 1}>`;
}
function declarationKind(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isArrowFunction(node)) return "arrow_function";
  if (ts.isFunctionExpression(node)) return "function_expression";
  return "function";
}
function declaredContainer(node, sourceFile) {
  const names = [];
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isModuleDeclaration(current))
      && current.name) names.unshift(current.name.getText(sourceFile));
    else if (FUNCTION_KINDS.has(current.kind)) names.unshift(symbolName(current, sourceFile));
  }
  return names.join(".") || "<module>";
}
function signatureDisambiguator(node, sourceFile) {
  const parameters = node.parameters?.map((parameter) => ({
    name: parameter.name.getText(sourceFile),
    type: parameter.type?.getText(sourceFile) ?? null,
    optional: Boolean(parameter.questionToken || parameter.initializer),
    rest: Boolean(parameter.dotDotDotToken),
  })) ?? [];
  return JSON.stringify({ parameters, typeParameters: node.typeParameters?.length ?? 0,
    async: Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async), generator: Boolean(node.asteriskToken) });
}
function isNestedFunction(node, root) { return node !== root && FUNCTION_KINDS.has(node.kind); }
function complexityOf(root) {
  let complexity = 1;
  function visit(node) {
    if (isNestedFunction(node, root)) return;
    if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node)
      || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
      || ts.isCatchClause(node) || ts.isConditionalExpression(node) || ts.isCaseClause(node)) complexity += 1;
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) complexity += 1;
    if (node.questionDotToken) complexity += 1;
    ts.forEachChild(node, visit);
  }
  if (root.body) visit(root.body);
  return complexity;
}
function isTypeOnly(node) {
  return ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
    || (ts.isExportDeclaration(node) && node.isTypeOnly)
    || (ts.isVariableStatement(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0);
}
function executableLinesOf(root, sourceFile) {
  const lines = new Set();
  const structuralTokens = new Set([ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.OpenBracketToken,
    ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.ColonToken]);
  function visit(node) {
    if (isNestedFunction(node, root) || isTypeOnly(node)) return;
    if (node.getChildCount(sourceFile) === 0 && !structuralTokens.has(node.kind)) {
      lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  if (root.body) visit(root.body);
  if (lines.size === 0 && root.body) lines.add(sourceFile.getLineAndCharacterOfPosition(root.body.getStart(sourceFile)).line + 1);
  return [...lines].sort((left, right) => left - right);
}
function astFingerprint(node, sourceFile) {
  const parts = [];
  function visit(current) {
    if (isNestedFunction(current, node) || isTypeOnly(current)) return;
    parts.push(ts.SyntaxKind[current.kind]);
    if (ts.isIdentifier(current) || ts.isLiteralExpression(current)) parts.push(current.getText(sourceFile));
    if (ts.isBinaryExpression(current)) parts.push(ts.SyntaxKind[current.operatorToken.kind]);
    if (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) parts.push(String(current.operator));
    if (ts.isVariableDeclarationList(current)) parts.push(String(current.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)));
    ts.forEachChild(current, visit);
  }
  visit(node);
  return parts.join("|");
}
export function analyzeSource(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  if (sourceFile.parseDiagnostics.length > 0) {
    const first = sourceFile.parseDiagnostics[0];
    const position = sourceFile.getLineAndCharacterOfPosition(first.start ?? 0);
    throw new Error(`${filePath}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`);
  }
  const symbols = [];
  function visit(node) {
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.end);
      const name = symbolName(node, sourceFile);
      const container = declaredContainer(node, sourceFile);
      symbols.push({ name, qualifiedName: container === "<module>" ? name : `${container}.${name}`, container,
        declarationKind: declarationKind(node), disambiguator: signatureDisambiguator(node, sourceFile),
        startLine: start.line + 1, endLine: end.line + 1,
        complexity: complexityOf(node), executableLines: executableLinesOf(node, sourceFile), ast: astFingerprint(node, sourceFile) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return symbols;
}
