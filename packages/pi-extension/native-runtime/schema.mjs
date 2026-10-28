// The classifier's restricted schema vocabulary, converted without weakening score bounds.
export function nativeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('NATIVE_SCHEMA_UNSUPPORTED');
  if (schema.anyOf) return { oneOf: schema.anyOf.map(nativeSchema) };
  if (schema.enum) return { enum: schema.enum };
  if (Object.hasOwn(schema, 'const')) return { const: schema.const };
  if (schema.type === 'integer' && Number.isInteger(schema.minimum) && Number.isInteger(schema.maximum)) {
    if (schema.maximum - schema.minimum > 100) throw Error('NATIVE_SCHEMA_UNSUPPORTED');
    return { enum: Array.from({ length: schema.maximum - schema.minimum + 1 }, (_, i) => schema.minimum + i) };
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    if (schema.additionalProperties !== false ||
      Object.keys(properties).some(key => !schema.required?.includes(key))) throw Error('NATIVE_SCHEMA_UNSUPPORTED');
    return { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([key, value]) =>
      [key, nativeSchema(value)])), additionalProperties: false };
  }
  if (schema.type === 'array') {
    const out = { type: 'array' };
    for (const key of ['minItems', 'maxItems']) if (schema[key] !== undefined) out[key] = schema[key];
    if (schema.items) out.items = nativeSchema(schema.items);
    if (schema.prefixItems) out.prefixItems = schema.prefixItems.map(nativeSchema);
    return out;
  }
  if (['string', 'integer', 'number', 'null', 'boolean'].includes(schema.type)) {
    const out = { type: schema.type };
    for (const key of ['minLength', 'maxLength']) if (schema[key] !== undefined) out[key] = schema[key];
    // Identifier patterns remain enforced by the existing Python semantic validator.
    return out;
  }
  throw Error('NATIVE_SCHEMA_UNSUPPORTED');
}
