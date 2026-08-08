/**
 * Seeds a form with the defaults declared on an adapter's Zod schema.
 *
 * Pulled out of `adapter-form.tsx` so it can be tested, which is how the following was
 * found: it had been silently doing nothing since the upgrade to Zod 4. It checked
 * `_def.typeName === "ZodDefault"`, a Zod 3 API that now reports `undefined`, and then
 * called `_def.defaultValue()`, which is a value in Zod 4 rather than a function. So the
 * condition never matched, and if it had, the call would have thrown.
 *
 * The visible symptom was every adapter form starting empty where a default should have
 * been - a placeholder saying "22" where the field itself held nothing.
 */

/**
 * Keys that choose the shape of the form rather than a value in it.
 *
 * Both the database and the storage form deliberately show nothing until one of these is
 * picked, because the two modes ask for different things and guessing would present the
 * wrong form. Seeding them would answer a question the user has not been asked yet.
 */
const LAYOUT_KEYS = new Set(["connectionMode", "mode"]);

/**
 * The slice of a react-hook-form instance this needs.
 *
 * Paths are typed as `config.<key>` rather than plain strings so the real form's own typed
 * `setValue` is assignable - it only accepts paths it knows, and every field here is under
 * `config`.
 */
interface FormLike {
    getValues: (name: `config.${string}`) => unknown;
    setValue: (name: `config.${string}`, value: never) => void;
}

/** Reads the default off a schema node, walking Optional and Nullable wrappers to find it. */
function defaultValueOf(node: unknown): { found: boolean; value?: unknown } {
    let current = node;
    while (current) {
        const def = (current as { _def?: { type?: string; defaultValue?: unknown; innerType?: unknown } })._def;
        if (!def) return { found: false };
        if (def.type === "default") {
            // Zod 4 stores the value itself. Older versions stored a thunk, and a schema
            // built by another copy of zod could still hand one over.
            const raw = def.defaultValue;
            return { found: true, value: typeof raw === "function" ? (raw as () => unknown)() : raw };
        }
        if (!def.innerType) return { found: false };
        current = def.innerType;
    }
    return { found: false };
}

export function seedSchemaDefaults(schema: unknown, form: FormLike): void {
    const shape = (schema as { shape?: Record<string, unknown> })?.shape;
    if (!shape) return;

    for (const [key, node] of Object.entries(shape)) {
        if (LAYOUT_KEYS.has(key)) continue;
        // Never overwrite something the user has already typed.
        if (form.getValues(`config.${key}`) !== undefined) continue;

        const { found, value } = defaultValueOf(node);
        if (found) form.setValue(`config.${key}`, value as never);
    }
}
