// S10: validator for profile.schema.json.
//
// Interprets the subset of JSON Schema 2020-12 the schema uses, reading the schema
// object passed in so there is one source of truth (mirrors contract/validate.py).
// Any keyword it does not implement throws SchemaError, so a schema edit can never
// silently weaken this validator.
//
// Two phases, same split as contract/validate.py: validateSchema() checks structure
// and types; checkIntegrity() checks things a closed JSON Schema cannot express here,
// such as a topic id's shape (open set, so it cannot be an enum) and cross references
// between fields (a muted topic must be a topic that exists).

export class SchemaError extends Error {}

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "$comment", "title", "description"]);
const ASSERTIONS = new Set([
  "$ref", "type", "const", "enum", "required", "properties", "additionalProperties",
  "items", "minItems", "maxItems", "minProperties", "pattern", "minLength", "maxLength",
  "minimum", "maximum",
]);

const TOPIC_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueTypeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeOk(value, name) {
  switch (name) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new SchemaError(`unknown type ${name}`);
  }
}

function same(a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return a === b;
}

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new SchemaError(`only local refs are supported: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) node = node[part];
  return node;
}

function check(value, schema, root, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: not allowed`);
    return;
  }
  const unknown = Object.keys(schema).filter((k) => !ANNOTATIONS.has(k) && !ASSERTIONS.has(k));
  if (unknown.length) throw new SchemaError(`unsupported keywords ${JSON.stringify(unknown)} at ${path}`);

  if (schema.$ref) check(value, resolve(root, schema.$ref), root, path, errors);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) {
      errors.push(`${path}: expected ${types.join("/")}, got ${valueTypeName(value)}`);
      return;
    }
  }
  if ("const" in schema && !same(value, schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((v) => same(value, v))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items) value.forEach((item, i) => check(item, schema.items, root, `${path}[${i}]`, errors));
  }

  if (isPlainObject(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path}: fewer than ${schema.minProperties} properties`);
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required field ${JSON.stringify(key)}`);
    }
    const props = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (key in props) check(item, props[key], root, `${path}.${key}`, errors);
      else if (schema.additionalProperties !== undefined) {
        check(item, schema.additionalProperties, root, `${path}.${key}`, errors);
      }
    }
  }
}

/** Schema-only structural check. Returns a list of error strings; empty means valid. */
export function validateSchema(profile, schema) {
  const errors = [];
  check(profile, schema, schema, "$", errors);
  return errors;
}

/** Checks the schema cannot express: topic id shape, and references between fields. */
export function checkIntegrity(profile) {
  const errors = [];
  const topics = profile.topics || {};
  for (const id of Object.keys(topics)) {
    if (!TOPIC_ID_PATTERN.test(id)) {
      errors.push(`$.topics.${id}: topic id must be lowercase letters, digits and underscores, starting with a letter`);
    }
  }
  const boostIds = new Set();
  (profile.boosts || []).forEach((boost, i) => {
    if (boostIds.has(boost.id)) errors.push(`$.boosts[${i}].id: duplicate boost id ${JSON.stringify(boost.id)}`);
    boostIds.add(boost.id);
  });
  for (const topicId of (profile.mutes && profile.mutes.topics) || []) {
    if (!(topicId in topics)) {
      errors.push(`$.mutes.topics: ${JSON.stringify(topicId)} is not a topic in this profile`);
    }
  }
  return errors;
}

/** The full check: schema first, then integrity only once the schema itself is clean. */
export function validateProfile(profile, schema) {
  const schemaErrors = validateSchema(profile, schema);
  if (schemaErrors.length) return schemaErrors;
  return checkIntegrity(profile);
}
