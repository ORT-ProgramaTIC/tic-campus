import { ApiError } from "../middleware/errors.js";

/**
 * **The mark formula** (F20): a small expression language a teacher writes, and
 * the evaluator that turns it into a number.
 *
 * `0.7*avg(tps) + 0.3*10*done_ratio(clase)`
 *
 * **No `eval`, no `Function`, no dependency.** A hand-written tokenizer and a
 * recursive-descent parser, which is also the only option available — there is
 * no zod and there are seven runtime dependencies, none of which is a parser.
 *
 * Three properties this file exists to hold, in the order they matter:
 *
 * - **A wrong number is worse than a page that is down.** Nothing here ever
 *   returns `NaN` or `Infinity`: `evaluateFormula` gives a number, a `null`
 *   meaning *sin nota*, or an error string a teacher can read. A `NaN` that
 *   reaches a boletín is the failure this whole file is shaped against, which
 *   is why division by zero is an error rather than a quiet `null`.
 * - **A formula cannot name an activity** (F20), only a group — so renaming or
 *   adding an activity can never break one.
 * - **The source text is the only stored form** (F40). This parses on read,
 *   which costs microseconds; a compiled AST beside the text would be a second
 *   thing that can disagree with it.
 *
 * **Names, not keys** — F39's open half, settled in slice 8. A formula spells
 * the group's own name, and `writeSetup` refuses a save that would leave a
 * formula naming a group that no longer exists. The alternative was an
 * immutable `key` column: rejected because a name is free text (`Trabajos
 * Prácticos`) and so is unspellable as a bare identifier *either way*, and a
 * key is a second name that stops matching the screen after one rename —
 * exactly the kind of drift that makes a wrong number hard to see.
 *
 * The scope is a plain `Record<string, Value>`, which is what lets **one
 * evaluator serve both formulas** (F21): a term's formula resolves names to
 * groups, and the final's resolves them to the terms' own computed marks.
 */

/* ── What a name resolves to ─────────────────────────────────────────────── */

/**
 * A group as the evaluator sees it: the marks that exist, and separately how
 * many done/not-done activities there are.
 *
 * **`xs` holds numeric and scale results only, and `doneTotal` counts
 * activities rather than results** — that split is F20's blank rule spelled as
 * a data shape. A missing numeric or scale result is left out of the
 * aggregates; a missing done counts as *not done*, so the denominator has to
 * come from the activity list and cannot come from the rows.
 */
export interface GroupValue {
  kind: "group";
  xs: number[];
  done: number;
  doneTotal: number;
}

export type Value =
  | { kind: "number"; n: number }
  | { kind: "null" }
  | { kind: "list"; xs: number[] }
  | GroupValue;

export const NO_MARK: Value = { kind: "null" };

/** A term's own mark, as the final formula sees it (F21). */
export function markValue(mark: number | null): Value {
  return mark === null ? NO_MARK : { kind: "number", n: mark };
}

/* ── The tree ────────────────────────────────────────────────────────────── */

export type Node =
  | { kind: "num"; n: number }
  | { kind: "ref"; name: string; at: number }
  | { kind: "call"; name: string; args: Node[]; at: number }
  | { kind: "neg"; operand: Node }
  | { kind: "op"; op: BinaryOp; left: Node; right: Node };

type BinaryOp = "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=";

/** Source text cap. Long enough for anything a boletín needs, short enough that
 *  the parse is bounded without counting anything else. */
export const MAX_FORMULA = 500;

/** Nesting cap. The language has no loops and no recursion, so this plus
 *  `MAX_FORMULA` is the whole of its runtime bound. */
const MAX_DEPTH = 32;

/** Arity, and the whole of what a name may be (F20's seven). `max` is
 *  `Infinity` for the ones that pool their arguments. */
const FUNCTIONS: Record<string, { min: number; max: number }> = {
  avg: { min: 1, max: Infinity },
  min: { min: 1, max: Infinity },
  max: { min: 1, max: Infinity },
  drop_lowest: { min: 1, max: 2 },
  done_ratio: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  if: { min: 3, max: 3 },
};

/* ── Tokens ──────────────────────────────────────────────────────────────── */

interface Token {
  type: "num" | "name" | "punct";
  text: string;
  /** Character offset, 0-based, so a message can say *posición N* and an editor
   *  can put a caret there. */
  at: number;
  /** A quoted name is never a call, so `"avg"(x)` is a group named `avg` being
   *  used where a number was wanted, not a call. */
  quoted: boolean;
}

/** Identifier characters: Unicode letters, so `avg(física)` needs no quotes.
 *  Anything with a space or punctuation in it is quoted instead. */
const NAME_START = /\p{L}|_/u;
const NAME_PART = /\p{L}|\p{N}|_/u;

const PUNCT = [
  "<=",
  ">=",
  "==",
  "!=",
  "+",
  "-",
  "*",
  "/",
  "(",
  ")",
  ",",
  "<",
  ">",
];

function fail(message: string, at: number): never {
  throw new ApiError(
    400,
    "formula_invalid",
    `${message} (posición ${at + 1}).`,
  );
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/\d/.test(char)) {
      const start = i;
      while (i < text.length && /\d/.test(text[i]!)) i += 1;
      if (text[i] === ".") {
        i += 1;
        if (!/\d/.test(text[i] ?? "")) {
          fail("Falta un dígito después del punto", i);
        }
        while (i < text.length && /\d/.test(text[i]!)) i += 1;
      }
      tokens.push({
        type: "num",
        text: text.slice(start, i),
        at: start,
        quoted: false,
      });
      continue;
    }
    if (char === '"') {
      const start = i;
      i += 1;
      let name = "";
      while (i < text.length && text[i] !== '"') {
        name += text[i];
        i += 1;
      }
      if (i >= text.length) fail("Falta cerrar la comilla", start);
      i += 1;
      if (name.trim() === "")
        fail("El nombre entre comillas está vacío", start);
      tokens.push({ type: "name", text: name.trim(), at: start, quoted: true });
      continue;
    }
    if (NAME_START.test(char)) {
      const start = i;
      while (i < text.length && NAME_PART.test(text[i]!)) i += 1;
      tokens.push({
        type: "name",
        text: text.slice(start, i),
        at: start,
        quoted: false,
      });
      continue;
    }
    const punct = PUNCT.find((p) => text.startsWith(p, i));
    if (punct === undefined) fail(`No entendemos «${char}»`, i);
    tokens.push({ type: "punct", text: punct, at: i, quoted: false });
    i += punct.length;
  }
  return tokens;
}

/* ── The parser ──────────────────────────────────────────────────────────── */

/**
 * Precedence climbing, one function per level. Comparisons sit at the bottom
 * and do not chain: `a < b < c` is a refusal rather than the thing C would do
 * with it, because nobody writing a boletín means that.
 */
function parse(tokens: Token[], text: string): Node {
  let at = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[at];
  const eat = (punct: string): boolean => {
    const token = peek();
    if (token?.type === "punct" && token.text === punct) {
      at += 1;
      return true;
    }
    return false;
  };
  const endOf = (): number => tokens[at]?.at ?? text.length;

  function expression(): Node {
    const left = sum();
    const token = peek();
    if (
      token?.type === "punct" &&
      ["<", "<=", ">", ">=", "==", "!="].includes(token.text)
    ) {
      at += 1;
      return { kind: "op", op: token.text as BinaryOp, left, right: sum() };
    }
    return left;
  }

  function sum(): Node {
    let left = product();
    for (;;) {
      const token = peek();
      if (token?.type !== "punct" || !["+", "-"].includes(token.text)) {
        return left;
      }
      at += 1;
      left = { kind: "op", op: token.text as BinaryOp, left, right: product() };
    }
  }

  function product(): Node {
    let left = unary();
    for (;;) {
      const token = peek();
      if (token?.type !== "punct" || !["*", "/"].includes(token.text)) {
        return left;
      }
      at += 1;
      left = { kind: "op", op: token.text as BinaryOp, left, right: unary() };
    }
  }

  function unary(): Node {
    if (eat("-")) return { kind: "neg", operand: unary() };
    return atom();
  }

  function nested<T>(build: () => T): T {
    depth += 1;
    if (depth > MAX_DEPTH) fail("La fórmula anida demasiado", endOf());
    const built = build();
    depth -= 1;
    return built;
  }

  function atom(): Node {
    const token = peek();
    if (token === undefined)
      fail("La fórmula termina antes de tiempo", text.length);
    if (token.type === "num") {
      at += 1;
      return { kind: "num", n: Number(token.text) };
    }
    if (token.type === "punct" && token.text === "(") {
      at += 1;
      const inner = nested(expression);
      if (!eat(")")) fail("Falta cerrar el paréntesis", endOf());
      return inner;
    }
    if (token.type !== "name") {
      fail(`No esperábamos «${token.text}» acá`, token.at);
    }
    at += 1;
    // A name is a call only when unquoted and followed by `(` — which is why
    // there are no reserved words: a group called `min` is `min`, and a call is
    // `min(...)`. One rule instead of two, and no escape hatch to document.
    const next = peek();
    if (token.quoted || next?.type !== "punct" || next.text !== "(") {
      return { kind: "ref", name: token.text, at: token.at };
    }
    at += 1;
    return nested((): Node => {
      const args: Node[] = [];
      if (!eat(")")) {
        do {
          args.push(expression());
        } while (eat(","));
        if (!eat(")")) fail("Falta cerrar el paréntesis", endOf());
      }
      return { kind: "call", name: token.text, args, at: token.at };
    });
  }

  const tree = expression();
  const left = peek();
  if (left !== undefined) fail(`Sobra «${left.text}»`, left.at);
  return tree;
}

/**
 * Text to tree. Throws `400 formula_invalid` with the position, and checks
 * every function name and arity on the way out so an editor gets one refusal
 * rather than one per save.
 */
export function parseFormula(text: string): Node {
  if (text.length > MAX_FORMULA) {
    throw new ApiError(
      400,
      "formula_invalid",
      `La fórmula no puede pasar de ${MAX_FORMULA} caracteres.`,
    );
  }
  if (text.trim() === "") {
    throw new ApiError(400, "formula_invalid", "La fórmula está vacía.");
  }
  const tree = parse(tokenize(text), text);
  checkCalls(tree);
  return tree;
}

function checkCalls(node: Node): void {
  switch (node.kind) {
    case "call": {
      const arity = FUNCTIONS[node.name];
      if (arity === undefined) {
        fail(`No conocemos la función «${node.name}»`, node.at);
      }
      if (node.args.length < arity.min || node.args.length > arity.max) {
        fail(
          `«${node.name}» no lleva ${node.args.length} argumento${node.args.length === 1 ? "" : "s"}`,
          node.at,
        );
      }
      for (const arg of node.args) checkCalls(arg);
      return;
    }
    case "op":
      checkCalls(node.left);
      checkCalls(node.right);
      return;
    case "neg":
      checkCalls(node.operand);
      return;
    default:
      return;
  }
}

/** Every name the formula reads, in source order, deduplicated. What the save
 *  checks against the offering's groups (or its terms, for the final). */
export function formulaNames(node: Node): string[] {
  const found: string[] = [];
  const walk = (at: Node): void => {
    switch (at.kind) {
      case "ref":
        if (!found.includes(at.name)) found.push(at.name);
        return;
      case "call":
        for (const arg of at.args) walk(arg);
        return;
      case "op":
        walk(at.left);
        walk(at.right);
        return;
      case "neg":
        walk(at.operand);
        return;
      default:
        return;
    }
  };
  walk(node);
  return found;
}

/**
 * Parse, then refuse any name that is not one of `known` — the save-time
 * validator F40 asks for. `noun` names what the formula is allowed to mention,
 * since a term's formula reads groups and the final reads terms.
 */
export function checkFormula(
  text: string,
  known: Iterable<string>,
  noun = "grupo",
): Node {
  const tree = parseFormula(text);
  const names = new Set(known);
  for (const name of formulaNames(tree)) {
    if (!names.has(name)) {
      throw new ApiError(
        400,
        "formula_invalid",
        `La fórmula nombra un ${noun} que no existe: «${name}».`,
      );
    }
  }
  return tree;
}

/* ── Evaluation ──────────────────────────────────────────────────────────── */

/** Thrown inside, caught at the top of `evaluateFormula` and turned into a
 *  string. Never an `ApiError`: a formula that does not compute for one student
 *  is a cell with a message in it, not a failed request. */
class FormulaError extends Error {}

function bad(message: string): never {
  throw new FormulaError(message);
}

export type Computed = { value: number | null } | { error: string };

/**
 * Run the tree against one student's scope.
 *
 * **Never `NaN`, never `Infinity`.** The three outcomes are a number, `null`
 * (*sin nota* — nothing to compute from yet), and an error a teacher reads.
 */
export function evaluateFormula(
  tree: Node,
  scope: Record<string, Value>,
): Computed {
  try {
    const value = run(tree, scope);
    if (value.kind === "null") return { value: null };
    if (value.kind !== "number") {
      // `tps` alone, where a number was meant. Worth its own message: it is the
      // mistake a teacher makes first.
      return {
        error: "La fórmula termina en un grupo. Envolvelo en avg(...).",
      };
    }
    if (!Number.isFinite(value.n))
      return { error: "El resultado no es un número." };
    return { value: value.n };
  } catch (cause) {
    if (cause instanceof FormulaError) return { error: cause.message };
    throw cause;
  }
}

function run(node: Node, scope: Record<string, Value>): Value {
  switch (node.kind) {
    case "num":
      return { kind: "number", n: node.n };
    case "ref": {
      const found = scope[node.name];
      // Reachable only through a race — the save refuses a formula naming
      // something that is not there, and a delete refuses while a formula names
      // it. Handled anyway, because the alternative is `undefined` arithmetic.
      if (found === undefined) bad(`«${node.name}» ya no existe.`);
      return found;
    }
    case "neg": {
      const inner = asNumber(run(node.operand, scope), "-");
      return inner === null ? NO_MARK : num(-inner);
    }
    case "op":
      return operate(node, scope);
    case "call":
      return call(node, scope);
  }
}

function operate(
  node: Extract<Node, { kind: "op" }>,
  scope: Record<string, Value>,
): Value {
  const left = asNumber(run(node.left, scope), node.op);
  const right = asNumber(run(node.right, scope), node.op);
  // Sin nota propagates through arithmetic: a term with nothing marked yet is
  // not a zero. It deliberately does NOT propagate through avg/min/max, which
  // leave a blank out instead — the two rules are tested against each other.
  if (left === null || right === null) return NO_MARK;
  switch (node.op) {
    case "+":
      return num(left + right);
    case "-":
      return num(left - right);
    case "*":
      return num(left * right);
    case "/":
      // Not a null: a null reads as "todavía no hay nota" and this is a bug in
      // the formula, which the teacher has to be able to see and fix.
      if (right === 0) bad("División por cero.");
      return num(left / right);
    case "<":
      return bool(left < right);
    case "<=":
      return bool(left <= right);
    case ">":
      return bool(left > right);
    case ">=":
      return bool(left >= right);
    case "==":
      return bool(left === right);
    case "!=":
      return bool(left !== right);
  }
}

function bool(is: boolean): Value {
  return { kind: "number", n: is ? 1 : 0 };
}

/**
 * Every number the evaluator produces, rounded to ten decimals.
 *
 * **Not cosmetic.** `0.7*7 + 0.3*10` is `7.899999999999999` in binary floating
 * point, which prints as that on a boletín and, worse, loses
 * `if(x >= 7.9, ...)` — a threshold a teacher wrote and a mark that comes out
 * wrong. Marks are one to ten with two decimals (`checkMark`), so ten decimals
 * is far below anything real and far above the error this removes. A teacher
 * who wants two decimals still says `round(x, 2)`; this only deletes the noise
 * underneath the number they meant.
 */
function num(n: number): Value {
  return { kind: "number", n: Math.round(n * 1e10) / 1e10 };
}

function asNumber(value: Value, what: string): number | null {
  if (value.kind === "number") return value.n;
  if (value.kind === "null") return null;
  bad(`«${what}» necesita un número, no un grupo. Probá avg(...).`);
}

/**
 * Pool every argument into one list of numbers: a group contributes its marks,
 * a list its items, a number itself, and a `null` nothing at all.
 *
 * One rule covering two shapes on purpose. `avg(tps)` is the mean of the
 * group's marks and `avg(t1, t2, t3)` is the mean of three term marks, and
 * dropping a `null` here is the same "a blank is left out of the aggregates"
 * (F20) applied one level up — a term nobody has marked yet does not drag the
 * final down, the way an unmarked TP does not drag a term down.
 */
function pool(values: Value[]): number[] {
  const xs: number[] = [];
  for (const value of values) {
    if (value.kind === "number") xs.push(value.n);
    else if (value.kind === "list" || value.kind === "group")
      xs.push(...value.xs);
  }
  return xs;
}

function call(
  node: Extract<Node, { kind: "call" }>,
  scope: Record<string, Value>,
): Value {
  // `if` before the arguments are evaluated, and it is the only one: a guard is
  // written precisely to keep the branch it rejects from running, so
  // `if(n > 0, 10/n, 0)` must not divide by zero on the way to not using it.
  if (node.name === "if") {
    const condition = asNumber(run(node.args[0]!, scope), "if");
    if (condition === null) return NO_MARK;
    return run(node.args[condition === 0 ? 2 : 1]!, scope);
  }
  const args = node.args.map((arg) => run(arg, scope));
  switch (node.name) {
    case "avg": {
      const xs = pool(args);
      if (xs.length === 0) return NO_MARK;
      return num(xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    case "min": {
      const xs = pool(args);
      return xs.length === 0 ? NO_MARK : num(Math.min(...xs));
    }
    case "max": {
      const xs = pool(args);
      return xs.length === 0 ? NO_MARK : num(Math.max(...xs));
    }
    case "drop_lowest": {
      // The second argument is a count, not more data, which is why this one
      // does not pool: `drop_lowest(tps, 2)` drops two marks from `tps`.
      const xs = pool([args[0]!]);
      const howMany = args.length === 2 ? asCount(args[1]!) : 1;
      return { kind: "list", xs: [...xs].sort((a, b) => a - b).slice(howMany) };
    }
    case "done_ratio": {
      const group = args[0]!;
      if (group.kind !== "group") {
        // Also what makes it unusable in the final formula, where a name is a
        // term's mark and there is no activity list behind it.
        bad("«done_ratio» necesita un grupo de actividades.");
      }
      if (group.doneTotal === 0) return NO_MARK;
      return num(group.done / group.doneTotal);
    }
    case "round": {
      const x = asNumber(args[0]!, "round");
      if (x === null) return NO_MARK;
      const digits = args.length === 2 ? asCount(args[1]!) : 0;
      const scale = 10 ** Math.min(digits, 10);
      return num(Math.round(x * scale) / scale);
    }
    default:
      // `parseFormula` refuses an unknown name, so this is unreachable — and it
      // is a `bad` rather than a silent `null` so that it stays that way.
      bad(`No conocemos la función «${node.name}».`);
  }
}

function asCount(value: Value): number {
  const n = asNumber(value, "la cantidad");
  if (n === null || n < 0) bad("La cantidad tiene que ser un número positivo.");
  return Math.round(n);
}
