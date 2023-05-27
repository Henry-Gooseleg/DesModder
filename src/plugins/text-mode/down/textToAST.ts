import TextAST, {
  Node,
  Expression,
  isExpression,
  Pos,
  isStatement,
} from "./TextAST";
import { DiagnosticsState } from "./diagnostics";
import { Diagnostic } from "@codemirror/lint";
import * as moo from "moo";
import { autoCommandNames, autoOperatorNames } from "utils/depUtils";

// prettier-ignore
const punct = [
  "<", "<=", "=", ">=", ">", "~",
  "->", ",", ":", "...", ".", "'",
  "+", "-", "*", "/", "^", "!", "d/d", // '% of' TODO
  "@{", "#{", "(",  ")", "[", "]", "{", "}",
] as const

type Punct = (typeof punct)[number];

const rules = {
  comment: /\/\/[^\n]*/,
  number: /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/,
  punct: [...punct],
  id: {
    match: /[a-zA-Z][a-zA-Z0-9_]*/,
    type: moo.keywords({
      // prettier-ignore
      keyword: [
        "table", "image", "settings", "folder", "ticker",
        "for", "integral", "sum", "product", "of", "with"
      ],
    }),
  },
  string: /"(?:[^"\\]|\\.)*?"/,
  prime: /'+/,
  semi: { match: /;|[ \t\n]*\n[ \t\n]*\n[ \t\n]*/, lineBreaks: true },
  space: { match: /[ \t\n]+/, lineBreaks: true },
  invalid: { match: /[^]/, lineBreaks: true },
};

const _power = [
  "top",
  "meta",
  "seq",
  "rel",
  "sim",
  "updateRule",
  "substitution",
  "derivative",
  "add",
  "mul",
  "prefix",
  "pow",
  "postfix",
  "call",
  "access",
  "member",
] as const;

const Power = Object.fromEntries(
  _power.map((k, i) => [k, (i * 10) as BindingPower])
) as Record<(typeof _power)[number], BindingPower>;

type BindingPower = number & { __nominallyPower: undefined };

function minus1(bp: BindingPower) {
  return (bp - 1) as BindingPower;
}

type TokenType = "eof" | "keyword" | keyof typeof rules;

type Token = Exclude<moo.Token, "type"> & { type: TokenType };

class ParseState extends DiagnosticsState {
  private curr: Token | null = null;
  private prevToken?: Token;
  private readonly lexer;

  constructor(input: string) {
    super();
    this.lexer = moo.compile(rules);
    this.lexer.reset(input);
  }

  private _next() {
    const t = this.lexer.next() as Token | undefined;
    this.prevToken = t;
    return t;
  }

  private next(): Token {
    while (true) {
      const prev = this.prevToken;
      const t = this._next();
      if (t === undefined)
        return {
          type: "eof",
          value: "",
          offset: prev ? prev.offset + prev.text.length : 0,
          text: "",
          lineBreaks: 0,
          line: prev ? prev.line + prev.lineBreaks : 0,
          col: prev ? prev.col + prev.text.length : 0,
        };
      if (t.type === "invalid")
        this.pushError(`Invalid character ${t.value}`, pos(t));
      if (!["space", "invalid", "comment"].includes(t.type)) return t;
    }
  }

  scanToNextStatement() {
    if (this.curr?.type === "semi") return;
    this.curr = null;
    while (true) {
      const t = this._next();
      if (t === undefined || t.type === "semi") break;
    }
  }

  peek() {
    if (this.curr === null) this.curr = this.next();
    return this.curr;
  }

  private _consume() {
    if (this.curr === null) return this.next();
    const c = this.curr;
    this.curr = null;
    return c;
  }

  consume(expected?: string) {
    while (true) {
      const c = this._consume();
      this.assertNotEOF(c);
      if (expected === undefined || expected === c.value) return c;
      this.pushError(
        `Expected '${expected}' but got '${c.value}'. Skipping it.`,
        pos(c)
      );
    }
  }

  consumeType(expected: TokenType) {
    while (true) {
      const c = this._consume();
      this.assertNotEOF(c);
      if (expected === c.type) return c;
      this.pushError(
        `Expected ${expected} but got '${c.value}'. Skipping it.`,
        pos(c)
      );
    }
  }

  assertNotEOF(token: Token) {
    if (token.type === "eof")
      throw this.pushFatalError("Unexpected end of file", pos(token));
  }

  pushFatalError(message: string, pos: TextAST.Pos | undefined) {
    this.pushError(message, pos);
    return new ParseError(message);
  }
}

class ParseError extends Error {}

export function parse(input: string): [Diagnostic[], TextAST.Program] {
  const ps = new ParseState(input);
  const children = parseStatements(ps, { isTop: true });
  if (children.length === 0 && ps.diagnostics.length === 0)
    ps.pushWarning("Program is empty. Try typing: y=x", { from: 0, to: 0 });
  if (ps.peek().type !== "eof")
    ps.pushError("Didn't reach end", pos(ps.peek()));
  const program: TextAST.Program = {
    type: "Program",
    children,
    pos: posMany(children.map((x) => x.pos).filter((p) => p) as Pos[], {
      from: 0,
      to: 0,
    }),
  };

  return [ps.diagnostics, program];
}

/** Returns either a node or array of errors */
function parseMain(
  ps: ParseState,
  lastBindingPower: BindingPower,
  { isStatementTop } = { isStatementTop: false }
): TextAST.Node {
  const firstToken = ps.consume();
  const initial = getInitialParselet(firstToken);
  if (!initial)
    throw ps.pushFatalError(
      `Unexpected text: '${firstToken.value}'.`,
      pos(firstToken)
    );
  let leftNode = initial(ps, firstToken);

  while (true) {
    const nextToken = ps.peek();
    const cp = consequentParselets[nextToken.value as Punct | "with"];
    if (!cp) break;
    if (cp.bindingPower <= lastBindingPower) break;
    ps.consume();
    leftNode = cp.parse(ps, leftNode, nextToken, {
      topLevelEq: isStatementTop && nextToken.value === "=",
    });
  }
  return leftNode;
}

function parseExpr(
  ps: ParseState,
  lastBindingPower: BindingPower,
  posMsg: string,
  example: string
): TextAST.Expression {
  const result = parseMain(ps, lastBindingPower);
  if (!isExpression(result))
    throw ps.pushFatalError(
      `Expected ${posMsg} to be an expression. Did you mean to write something like '${example}'?`,
      pos(result)
    );
  return result;
}

function getInitialParselet(token: Token) {
  const tagGroup = initialParselets[token.type];
  if (typeof tagGroup === "function") return tagGroup;
  else return tagGroup?.[token.value];
}

type TokenMap<T> = {
  [key in TokenType]?: T | Record<string, T>;
};

type InitialParselet = (ps: ParseState, token: Token) => Node;

const initialParselets: TokenMap<InitialParselet> = {
  punct: {
    "(": (ps, token): Node => {
      if (ps.peek().value === "d/d") {
        ps.consume();
        const variable = id(ps, ps.consumeType("id"));
        ps.consume(")");
        const expr = parseExpr(
          ps,
          Power.derivative,
          "argument of derivative",
          "(d/d x) x^2"
        );
        return {
          type: "DerivativeExpression",
          expr,
          variable,
          pos: pos(token, expr),
        };
      }
      const inner = parseMain(ps, Power.top);
      const closeParen = ps.consume(")");
      if (inner.type === "SequenceExpression") {
        return {
          ...inner,
          parenWrapped: true,
          pos: pos(token, closeParen),
        };
      }
      return {
        ...inner,
        pos: pos(token, closeParen),
      };
    },
    "-": (ps, token): Node => {
      const bp = Power.prefix;
      const expr = parseExpr(ps, bp, "Argument of negative", "-x");
      return {
        type: "PrefixExpression",
        op: "-",
        expr,
        pos: pos(token, expr),
      };
    },
    "[": parseList,
    "{": (ps, token): Node => {
      const branches: TextAST.PiecewiseBranch[] = [];
      while (true) {
        const curr = parseExpr(
          ps,
          Power.seq,
          "condition of piecewise",
          "{x>3}"
        );
        const next = ps.consume();
        if (next.value === "}") {
          const first = branches.length === 0;
          if (first) assertComparison(ps, curr);
          const bool = first || isComparison(curr);
          branches.push({
            type: "PiecewiseBranch",
            condition: bool ? curr : { type: "Identifier", name: "else" },
            consequent: bool ? { type: "Number", value: 1 } : curr,
            pos: pos(curr),
          });
          return {
            type: "PiecewiseExpression",
            branches,
            pos: pos(token, next),
          };
        } else if (next.value === ":") {
          const consequent = parseExpr(
            ps,
            Power.seq,
            "branch of piecewise",
            "{x>3:5}"
          );
          assertComparison(ps, curr);
          branches.push({
            type: "PiecewiseBranch",
            condition: curr,
            consequent,
            pos: pos(curr, consequent),
          });
          const next = ps.consume();
          if (next.value === "}")
            return {
              type: "PiecewiseExpression",
              branches,
              pos: pos(token, next),
            };
          else if (next.value !== ",")
            throw ps.pushFatalError(
              "Unexpected character in Piecewise",
              pos(next)
            );
        } else if (next.value === ",") {
          assertComparison(ps, curr);
          branches.push({
            type: "PiecewiseBranch",
            condition: curr,
            consequent: { type: "Number", value: 1 },
            pos: pos(curr),
          });
        } else {
          throw ps.pushFatalError(
            "Unexpected character in Piecewise",
            pos(next)
          );
        }
      }
    },
    "@{": parseStyleMapping,
  },
  number: (_, token) => ({
    type: "Number",
    value: parseFloat(token.value),
    pos: pos(token),
  }),
  id: (ps, token) => id(ps, token),
  string: stringParselet,
  keyword: {
    sum: repeatedOperatorParselet("sum"),
    product: repeatedOperatorParselet("product"),
    integral: repeatedOperatorParselet("integral"),
    table: (ps, token) => {
      ps.consume("{");
      const columns = parseStatements(ps).flatMap((stmt) => {
        if (stmt.type !== "ExprStatement") {
          ps.pushError(
            "Expected a valid table column. Try: x1 = [1, 2, 3]",
            stmt.pos
          );
          return [];
        } else return [stmt];
      });
      const end = ps.consume("}");
      return {
        type: "Table",
        columns,
        pos: pos(token, end),
        style: null,
      };
    },
    folder: (ps, token): Node => {
      const title = stringParselet(ps, ps.consumeType("string"));
      ps.consume("{");
      const children = parseStatements(ps);
      const end = ps.consume("}");
      return {
        type: "Folder",
        children,
        title: title.value,
        pos: pos(token, end),
        style: null,
      };
    },
    image: (ps, token): Node => {
      const name = stringParselet(ps, ps.consumeType("string"));
      return {
        type: "Image",
        name: name.value,
        pos: pos(token, name),
        style: null,
      };
    },
    settings: (_ps, token): Node => {
      return {
        type: "Settings",
        style: null,
        pos: pos(token),
      };
    },
    ticker: (ps, token): Node => {
      const handler = parseExpr(ps, Power.meta, "ticker handler", "a -> a+1");
      return {
        type: "Ticker",
        handler,
        pos: pos(token, handler),
        style: null,
      };
    },
  },
};

const comparisonOps = ["<", ">", "<=", ">=", "="];

function assertComparison(ps: ParseState, node: TextAST.Expression) {
  if (!isComparison(node))
    throw ps.pushFatalError("Condition must be a comparison", node.pos);
}

function isComparison(node: TextAST.Expression) {
  return (
    node.type === "DoubleInequality" ||
    (node.type === "BinaryExpression" && comparisonOps.includes(node.op)) ||
    (node.type === "Identifier" && node.name === "else")
  );
}

function id(ps: ParseState, token: Token): TextAST.Identifier {
  return {
    type: "Identifier",
    name: normalizeID(ps, token),
    pos: pos(token),
  };
}

/**
 * Fragile names. Subset of those given by the following script:
 *
 *     const {BuiltInTable, CompilerFunctionTable} = require("core/math/ir/builtin-table")
 *     const builtins = Object.keys({...BuiltInTable, ...CompilerFunctionTable})
 *     const {getAutoOperators, getAutoCommands}  = require("main/mathquill-operators")
 *     const operators = new Set((getAutoOperators()+" "+getAutoCommands()).split(/[ |]/));
 *     console.log(builtins.filter(name => !operators.has(name)))
 */
const fragileNames = [
  "polyGamma",
  "argmin",
  "argmax",
  "uniquePerm",
  "rtxsqpone",
  "rtxsqmone",
  "hypot",
];

const desModderNames = ["else", "true", "false"];

const dontSubscriptIdentifiers = new Set([
  ...autoOperatorNames.split(" ").map((e) => e.split("|")[0]),
  ...autoCommandNames.split(" "),
  ...fragileNames,
  "index",
  "dt",
  ...desModderNames,
]);

/**
 * Pre-condition: expr.name matches:
 *  - [a-zA-Z][a-zA-Z0-9_]*
 *
 * Post-condition: expr.name matches either:
 *  - [a-zA-Z][a-zA-Z]*
 *  - [a-zA-Z][a-zA-Z]*_[a-zA-Z0-9]+
 */
function normalizeID(ps: ParseState, token: Token): string {
  const error = (msg: string) => {
    ps.pushError(msg, pos(token));
    return "error";
  };
  const parts = token.value.split("_");
  if (parts.length === 1) {
    const [p] = parts;
    if (p.length === 1 || dontSubscriptIdentifiers.has(p)) return p;
    return p[0] + "_" + p.slice(1);
  } else if (parts.length === 2) {
    const [main, subscript] = parts;
    if (subscript.length === 0) return error("Cannot end with '_'");
    if (/[0-9]/.test(main)) return error("Digits are not allowed before '_'");
    return main + "_" + subscript;
  } else {
    return error("Too many '_' in identifier");
  }
}

/** Parse statements until a '}' or EOF */
function parseStatements(ps: ParseState, { isTop } = { isTop: false }) {
  const out: TextAST.Statement[] = [];
  while (true) {
    let next = ps.peek();
    while (next.type === "semi") {
      ps.consume();
      next = ps.peek();
    }
    if (isTop && next.value === "}") {
      ps.pushError("Unexpected '}'", pos(next));
      ps.consume();
      continue;
    }
    if (next.value === "}" || next.type === "eof") return out;
    try {
      const stmt = parseMain(ps, Power.top, { isStatementTop: true });
      out.push(finalizeStatement(ps, stmt));
      const next = ps.peek();
      if (next.value === "}" || next.type === "eof") return out;
      ps.consumeType("semi");
    } catch (e) {
      // Errors should have been pushed to the ParseState
      // Someone threw an error
      if (!(e instanceof ParseError)) throw e;
      // Scan to the next statement
      ps.scanToNextStatement();
    }
  }
}

function stringParselet(_ps: ParseState, token: Token): TextAST.StringNode {
  return {
    type: "String",
    value: JSON.parse(token.value),
    pos: pos(token),
  };
}

function repeatedOperatorParselet(
  name: "sum" | "product" | "integral"
): InitialParselet {
  const ex = `(${name}=(1...5) x^2)`;
  return (ps, token): Node => {
    const index = id(ps, ps.consumeType("id"));
    ps.consume("=");
    ps.consume("(");
    const start = parseExpr(ps, Power.top, `lower bound of ${name}`, ex);
    ps.consume("...");
    const end = parseExpr(ps, Power.top, `Upper bound of ${name}`, ex);
    ps.consume(")");
    const expr = parseExpr(ps, Power.add, `Term expression of ${name}`, ex);
    return {
      type: "RepeatedExpression",
      name,
      index,
      start,
      end,
      expr,
      pos: pos(token, expr),
    };
  };
}

const consequentParselets: Record<
  Punct | "with",
  ConsequentParselet | undefined
> = {
  "+": binaryParselet(Power.add, "+"),
  "-": binaryParselet(Power.add, "-"),
  "*": binaryParselet(Power.mul, "*"),
  "/": binaryParselet(Power.mul, "/"),
  // Subtract 1 from the binding power to make it right-associative
  "^": binaryParselet(minus1(Power.pow), "^"),
  "(": consequentParselet(Power.call, parseFunctionCall),
  "'": consequentParselet(Power.call, (ps, left): Node => {
    if (left.type !== "Identifier")
      throw ps.pushFatalError(
        "Cannot use prime notation on a non-identifier",
        pos(left)
      );
    let order = 1;
    while (true) {
      const next = ps.consume();
      if (next.value === "'") order++;
      else if (next.value === "(") {
        const expr = parseFunctionCall(ps, left);
        return {
          type: "PrimeExpression",
          expr,
          order,
          pos: pos(left, expr),
        };
      } else {
        throw ps.pushFatalError("Expected '('", pos(next));
      }
    }
  }),
  "!": consequentParselet(Power.postfix, (ps, left, token): Node => {
    assertLeftIsExpression(ps, left, token, "x!");
    return {
      type: "PostfixExpression",
      op: "factorial",
      expr: left,
      pos: pos(left, token),
    };
  }),
  ".": consequentParselet(Power.member, (ps, left, token): Node => {
    assertLeftIsExpression(ps, left, token, "(2,3).x");
    const right = parseMain(ps, Power.member);
    if (right.type !== "Identifier")
      throw ps.pushFatalError(
        `Member access name must be an identifier but got ${right.type}`,
        pos(token)
      );
    return {
      type: "MemberExpression",
      object: left,
      property: right,
      pos: pos(left, right),
    };
  }),
  "[": consequentParselet(Power.access, (ps, left, token): Node => {
    assertLeftIsExpression(ps, left, token, "L[L>5]");
    const right = parseList(ps, token);
    return {
      type: "ListAccessExpression",
      expr: left,
      index:
        right.type === "ListExpression" && right.values.length === 1
          ? right.values[0]
          : right,
      pos: pos(left, right),
    };
  }),
  "<": compareOpParselet("<"),
  "<=": compareOpParselet("<="),
  "=": compareOpParselet("="),
  ">=": compareOpParselet(">="),
  ">": compareOpParselet(">"),
  "->": consequentParselet(Power.updateRule, (ps, left): Node => {
    if (left.type !== "Identifier")
      throw ps.pushFatalError(
        `Left side of update rule must be Identifier, but got ${left.type}`,
        pos(left)
      );
    const right = parseExpr(
      ps,
      Power.updateRule,
      "right side of action update rule",
      "a -> a+1"
    );
    return {
      type: "UpdateRule",
      variable: left,
      expr: right,
      pos: pos(left, right),
    };
  }),
  ",": consequentParselet(Power.seq, (ps, left, token): Node => {
    // Right-associative for no reason
    const ex = "a -> a+b, b -> a";
    assertLeftIsExpression(ps, left, token, ex);
    if (ps.peek().value === "...") return left;
    const right = parseExpr(ps, minus1(Power.seq), "right side of ','", ex);
    return {
      type: "SequenceExpression",
      left,
      right,
      pos: pos(left, right),
      parenWrapped: false,
    };
  }),
  "@{": consequentParselet(Power.meta, (ps, left, token): Node => {
    const stmt = finalizeStatement(ps, left);
    const style = parseStyleMapping(ps, token);
    return {
      ...stmt,
      style,
      pos: pos(stmt, style),
    };
  }),
  "~": consequentParselet(Power.sim, (ps, left, token): Node => {
    const ex = "y1 ~ m * x1 + b";
    assertLeftIsExpression(ps, left, token, ex);
    const right = parseExpr(ps, Power.sim, "Right side of '~", ex);
    return {
      type: "BinaryExpression",
      op: "~",
      left,
      right,
      pos: pos(left, right),
    };
  }),
  "#{": consequentParselet(Power.meta, (ps, left, token): Node => {
    if (!isStatement(left)) left = finalizeStatement(ps, left);
    if (
      left.type !== "ExprStatement" ||
      left.expr.type !== "BinaryExpression" ||
      left.expr.op !== "~"
    )
      throw ps.pushFatalError(
        "Regression Parameters '#{' must be preceded by a regression of the form `LHS ~ RHS`",
        pos(token)
      );
    const seq = parseBareSeq(ps, "y1 ~ m * x1 + b #{ m = 1.5, b = 2.3 }");
    const end = ps.consume("}");
    const entries = seq.map((expr): TextAST.RegressionEntry => {
      if (
        expr.type !== "BinaryExpression" ||
        expr.op !== "=" ||
        expr.left.type !== "Identifier"
      )
        throw ps.pushFatalError(
          "Regression mapping entry must be of the form 'name = 123'",
          pos(expr)
        );
      return {
        type: "RegressionEntry",
        variable: expr.left,
        value: expr.right,
        pos: pos(expr),
      };
    });
    const parameters: TextAST.RegressionParameters = {
      type: "RegressionParameters",
      entries,
      pos: pos(token, end),
    };
    return {
      ...left,
      parameters,
      pos: pos(left, parameters),
    };
  }),
  with: consequentParselet(Power.substitution, (ps, left, token): Node => {
    assertLeftIsExpression(ps, left, token, "f(x) with a=3");
    const assignments = parseBareSeq(ps, "f(x) with a=3,b=[1...5]").map(
      (item): TextAST.AssignmentExpression => {
        if (
          item.type !== "BinaryExpression" ||
          item.op !== "=" ||
          item.left.type !== "Identifier"
        )
          throw ps.pushFatalError(
            "List comprehension must set variable = identifier",
            pos(item)
          );
        return {
          type: "AssignmentExpression",
          variable: item.left,
          expr: item.right,
          pos: item.pos,
        };
      }
    );
    return {
      type: "Substitution",
      body: left,
      assignments,
      pos: pos(left, assignments[assignments.length - 1]),
    };
  }),
  "...": undefined,
  "]": undefined,
  "{": undefined,
  "}": undefined,
  ":": undefined,
  "d/d": undefined,
  ")": undefined,
};

type ListOrRange =
  | TextAST.RangeExpression
  | TextAST.ListExpression
  | TextAST.ListComprehension;

/** Assumes last token read is token "[" */
function parseList(ps: ParseState, token: Token): ListOrRange {
  const startValues = parseBareSeq(ps, "[1,2,3]");
  const next = ps.consume();
  if (next.value === "...") {
    if (ps.peek().value === ",") ps.consume();
    const endValues = parseBareSeq(ps, "[1,11,...,81,91]");
    const t = ps.consume("]");
    return {
      type: "RangeExpression",
      startValues,
      endValues,
      pos: pos(token, t),
    };
  } else if (next.value === "]") {
    return {
      type: "ListExpression",
      values: startValues,
      pos: pos(token, next),
    };
  } else if (next.type === "keyword" && next.value === "for") {
    if (startValues.length !== 1)
      throw ps.pushFatalError(
        "Expected exactly one expression before 'for'",
        pos(next)
      );
    const assignments = parseBareSeq(ps, "[a+b for a=[0,5,10],b=[1...5]]").map(
      (item): TextAST.AssignmentExpression => {
        if (
          item.type !== "BinaryExpression" ||
          item.op !== "=" ||
          item.left.type !== "Identifier"
        )
          throw ps.pushFatalError(
            "List comprehension must set variable = identifier",
            pos(item)
          );
        return {
          type: "AssignmentExpression",
          variable: item.left,
          expr: item.right,
          pos: item.pos,
        };
      }
    );
    const t = ps.consume("]");
    return {
      type: "ListComprehension",
      expr: startValues[0],
      assignments,
      pos: pos(token, t),
    };
  } else {
    throw ps.pushFatalError("Expected ']'", pos(next));
  }
}

/** Assumes last token read is token "@{" */
function parseStyleMapping(ps: ParseState, token: Token): TextAST.StyleMapping {
  const entries: TextAST.MappingEntry[] = [];
  while (true) {
    if (ps.peek().value === "}") {
      const close = ps.consume();
      return {
        type: "StyleMapping",
        entries,
        pos: pos(token, close),
      };
    }
    const key = ps.consumeType("id");
    ps.consume(":");
    const expr = parseMain(ps, Power.seq);
    if (!isExpression(expr) && expr.type !== "StyleMapping")
      throw ps.pushFatalError("Expected value on the right of ':'", pos(expr));
    entries.push({
      type: "MappingEntry",
      property: {
        type: "String",
        value: key.value,
        pos: pos(key),
      },
      expr,
      pos: pos(key, expr),
    });
    if (ps.peek().value !== "}") ps.consume(",");
  }
}

function finalizeStatement(ps: ParseState, expr: Node): TextAST.Statement {
  if (isStatement(expr)) return expr;
  else if (isExpression(expr)) return exprToStatement(ps, expr);
  // Stuff like Program or StyleMapping that should not show up in this context
  else
    throw ps.pushFatalError(
      `I don't know how to finalize '${expr.type}'`,
      pos(expr)
    );
}

function exprToStatement(ps: ParseState, expr: Expression): TextAST.Statement {
  if (expr.type === "String")
    return {
      type: "Text",
      text: expr.value,
      pos: expr.pos,
      style: null,
    };
  let residualVariable: TextAST.Identifier | undefined;
  // Convert `residualVariable = (LHS ~ RHS)` to appropriate form
  if (
    expr.type === "BinaryExpression" &&
    expr.op === "=" &&
    expr.right.type === "BinaryExpression" &&
    expr.right.op === "~"
  ) {
    const left = expr.left;
    if (left.type !== "Identifier") {
      throw ps.pushFatalError(
        `Residual variable must be identifier, but got ${left.type}`,
        pos(left)
      );
    }
    expr = expr.right;
    residualVariable = left;
  }
  const isRegression = expr.type === "BinaryExpression" && expr.op === "~";
  return {
    type: "ExprStatement",
    expr,
    style: null,
    pos:
      isRegression && residualVariable
        ? pos(residualVariable, expr)
        : pos(expr),
    parameters: undefined,
    residualVariable: isRegression ? residualVariable : undefined,
  };
}

function parseBareSeq(ps: ParseState, example: string): TextAST.Expression[] {
  const out = [];
  while (true) {
    const peek = ps.peek();
    if (peek.value === "]" || peek.value === "...") break;
    const item = parseExpr(ps, Power.seq, `item in sequence`, example);
    out.push(item);
    const next = ps.peek();
    if (next.value !== ",") break;
    ps.consume();
  }
  return out;
}

/** Assumes last token parsed is open paren '(' */
function parseFunctionCall(ps: ParseState, left: Node): TextAST.CallExpression {
  const args = ps.peek().value === ")" ? [] : parseBareSeq(ps, "f(x,y)");
  const next = ps.consume(")");
  if (left.type !== "Identifier" && left.type !== "MemberExpression")
    throw ps.pushFatalError("Function call must be an identifier", pos(left));
  return {
    type: "CallExpression",
    callee: left,
    arguments: args,
    pos: pos(left, next),
  };
}

function compareOpParselet(symbol: TextAST.CompareOp) {
  return consequentParselet(Power.rel, (ps, left, token, opts): Node => {
    const ex = `y ${symbol} x`;
    assertLeftIsExpression(ps, left, token, ex);
    const rightPrec = opts.topLevelEq ? minus1(Power.seq) : Power.rel;
    const right1 = parseExpr(ps, rightPrec, "right side of comparison", ex);
    if (!["<", "<=", ">=", ">"].includes(ps.peek().value)) {
      return {
        type: "BinaryExpression",
        op: symbol,
        left,
        right: right1,
        pos: pos(left, right1),
      };
    }
    // parse for double inequality
    const right = ps.consume();
    const rightOp = right.value as TextAST.CompareOp;
    if (relopDir(rightOp) !== relopDir(symbol)) {
      throw ps.pushFatalError(
        `Cannot chain ${rightOp} with ${symbol}`,
        pos(right)
      );
    }
    const ex2 = "y < x < -y";
    const right2 = parseExpr(ps, Power.rel, "right side of comparison", ex2);
    return {
      type: "DoubleInequality",
      left,
      leftOp: symbol,
      middle: right1,
      rightOp,
      right: right2,
      pos: pos(left, right2),
    };
  });
}

function relopDir(symbol: TextAST.CompareOp) {
  return symbol === "=" ? 0 : symbol[0] === "<" ? 1 : -1;
}

interface CPOpts {
  /** Only used for '=' parselet, which has special case for top level parse to
   * handle A = a -> a+1, b -> b+1  */
  topLevelEq?: boolean;
}

interface ConsequentParselet {
  bindingPower: number;
  parse: (ps: ParseState, left: Node, token: Token, opts: CPOpts) => Node;
}

function consequentParselet(
  bindingPower: BindingPower,
  parse: (ps: ParseState, left: Node, token: Token, opts: CPOpts) => Node
): ConsequentParselet {
  return { bindingPower, parse };
}

function binaryParselet(bp: BindingPower, op: TextAST.BinaryExpression["op"]) {
  return consequentParselet(bp, (ps, left, token): Node => {
    const ex = `2 ${op} x`;
    assertLeftIsExpression(ps, left, token, ex);
    const right = parseExpr(ps, bp, `right side of ${op}`, ex);
    return {
      type: "BinaryExpression",
      op,
      left,
      right,
      pos: pos(left, right),
    };
  });
}

function assertLeftIsExpression(
  ps: ParseState,
  node: TextAST.Node,
  posToken: Token,
  example: string
): asserts node is Expression {
  if (!isExpression(node))
    throw ps.pushFatalError(
      `Unexpected '${posToken.value}'. Did you mean to precede it by an expression, such as '${example}'?`,
      pos(posToken)
    );
}

function pos(
  start: { pos?: Pos; offset?: number },
  end: { pos?: Pos; offset?: number; text?: string } = start
): Pos | undefined {
  const from = start.pos?.from ?? start.offset;
  const to =
    end.pos?.to ??
    (end.offset !== undefined && end.text !== undefined
      ? end.offset + end.text.length
      : undefined);
  return from !== undefined && to !== undefined ? { from, to } : undefined;
}

function posMany(arr: Pos[], initial: Pos) {
  return arr.reduce(
    (a, b) => ({ from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }),
    initial
  );
}
