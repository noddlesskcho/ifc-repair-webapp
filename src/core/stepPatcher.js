const decoder = new TextDecoder();

// STEP structural delimiter bytes. All are single-byte in UTF-8, and every
// UTF-8 continuation byte is >= 0x80, so scanning for these byte values
// directly is safe even though string content elsewhere in the file (e.g. a
// storey name with accented characters) may contain multi-byte sequences.
const HASH = 0x23; // '#'
const EQUALS = 0x3d; // '='
const OPEN = 0x28; // '('
const CLOSE = 0x29; // ')'
const COMMA = 0x2c; // ','
const QUOTE = 0x27; // "'"
const ZERO = 0x30;
const NINE = 0x39;
const ARG_NAME = 2;
const ARG_LONG_NAME = 7;

function indexOfByte(bytes, byte, fromIndex) {
  for (let i = fromIndex; i < bytes.length; i++) {
    if (bytes[i] === byte) return i;
  }
  return -1;
}

function parseArguments(bytes, open) {
  const args = [];
  let argStart = open + 1;
  let depth = 0;
  let inString = false;
  for (let i = open + 1; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === QUOTE) {
      if (inString && bytes[i + 1] === QUOTE) {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (byte === OPEN) depth++;
    else if (byte === CLOSE) {
      if (depth === 0) {
        args.push({ start: argStart, end: i });
        return { args, end: i };
      }
      depth--;
    } else if (byte === COMMA && depth === 0) {
      args.push({ start: argStart, end: i });
      argStart = i + 1;
    }
  }
  return null;
}

/** Indexes every requested IfcBuildingStorey in one pass over the IFC bytes. */
function indexStoreyArguments(bytes, expressIds) {
  const remaining = new Set(expressIds);
  const found = new Map();
  let start = 0;

  while (remaining.size > 0) {
    const hash = indexOfByte(bytes, HASH, start);
    if (hash === -1) break;
    let cursor = hash + 1;
    let expressId = 0;
    let hasDigit = false;
    while (cursor < bytes.length && bytes[cursor] >= ZERO && bytes[cursor] <= NINE) {
      hasDigit = true;
      expressId = expressId * 10 + bytes[cursor] - ZERO;
      cursor++;
    }
    start = cursor;
    if (!hasDigit || bytes[cursor] !== EQUALS || !remaining.has(expressId)) continue;

    const open = indexOfByte(bytes, OPEN, cursor + 1);
    if (open === -1) break;
    const entityName = decoder.decode(bytes.subarray(cursor + 1, open)).trim().toUpperCase();
    if (entityName !== "IFCBUILDINGSTOREY") continue;
    const parsed = parseArguments(bytes, open);
    if (!parsed) break;
    found.set(expressId, parsed.args);
    remaining.delete(expressId);
    start = parsed.end + 1;
  }

  if (remaining.size > 0) {
    throw new Error(`IfcBuildingStorey #${[...remaining][0]} was not found in the IFC text.`);
  }
  return found;
}

function requiredStoreyArguments(index, expressId) {
  const args = index.get(expressId);
  if (!args) throw new Error(`IfcBuildingStorey #${expressId} was not found in the IFC text.`);
  if (args.length < 8) {
    throw new Error(`IfcBuildingStorey #${expressId} is malformed: expected at least 8 STEP arguments, found ${args.length}.`);
  }
  return args;
}

/**
 * Copies Name and LongName STEP tokens from each matched master storey to
 * its linked source storey. No spatial relationship, placement, elevation,
 * GUID or product line is modified.
 *
 * Deliberately never decodes the whole file into one JS string: a
 * multi-hundred-megabyte federated IFC export's STEP text can exceed V8's
 * maximum string length (~536 million UTF-16 code units), which throws
 * `RangeError: Cannot create a string longer than 0x1fffffe8 characters` on
 * a full-file `TextDecoder.decode()`/`TextEncoder.encode()` round trip --
 * verified against a real ~645 MB export. Every byte range this function
 * touches (an entity's argument list, a single replacement token) is
 * individually small; only tiny slices are ever decoded, and the output is
 * assembled by concatenating `Uint8Array` views, which has no such limit.
 */
export function patchIfcStoreyNames(bytes, changes) {
  if (changes.length === 0) return bytes;

  const requiredIds = new Set();
  for (const change of changes) {
    requiredIds.add(change.sourceStoreyId);
    requiredIds.add(change.toStoreyId);
  }
  const argumentIndex = indexStoreyArguments(bytes, requiredIds);

  const targetTokens = new Map();
  for (const change of changes) {
    if (!targetTokens.has(change.toStoreyId)) {
      const args = requiredStoreyArguments(argumentIndex, change.toStoreyId);
      targetTokens.set(change.toStoreyId, {
        name: bytes.slice(args[ARG_NAME].start, args[ARG_NAME].end),
        longName: bytes.slice(args[ARG_LONG_NAME].start, args[ARG_LONG_NAME].end),
      });
    }
  }

  const replacements = [];
  for (const change of changes) {
    const sourceArgs = requiredStoreyArguments(argumentIndex, change.sourceStoreyId);
    const target = targetTokens.get(change.toStoreyId);
    replacements.push({ start: sourceArgs[ARG_NAME].start, end: sourceArgs[ARG_NAME].end, value: target.name });
    replacements.push({ start: sourceArgs[ARG_LONG_NAME].start, end: sourceArgs[ARG_LONG_NAME].end, value: target.longName });
  }

  replacements.sort((a, b) => a.start - b.start);

  const parts = [];
  let cursor = 0;
  for (const replacement of replacements) {
    parts.push(bytes.subarray(cursor, replacement.start));
    parts.push(replacement.value);
    cursor = replacement.end;
  }
  parts.push(bytes.subarray(cursor));

  let totalLength = 0;
  for (const part of parts) totalLength += part.length;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
