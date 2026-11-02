const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const GROUP_AT = /^\{\{([^{}]*)\}\}/;
function renderPrompt(assembly) {
	return assembly.sections.map((section) => section.interpolate === false ? section.text : interpolate(section, assembly.variables, "section")).filter((text) => text.length > 0).join("\n\n");
}
/**
* Render the complete dynamic context snapshot, preserving literal contributions.
* @param assembly - the assembly whose contexts and variables to render.
* @returns the current full snapshot, or `''` when no context is active.
*/
function renderContextSnapshot(assembly) {
	return joinContextSections(renderContextSections(assembly));
}
/**
* The model-facing snapshot text for an already-rendered section list.
*
* A caller that also needs the sections renders them once and joins here, so a
* request does not interpolate every context twice.
* @param sections - sections from {@link renderContextSections}.
* @returns the current full snapshot, or `''` when no context is active.
*/
function joinContextSections(sections) {
	const body = sections.map((section) => section.text).join("\n\n");
	if (body.length === 0) return "";
	return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
}
/**
* The same snapshot, kept as the named contributions it was assembled from.
*
* {@link renderContextSnapshot} joins these for the model; a consumer that
* presents the snapshot uses them to attribute each part to the subsystem that
* contributed it, without re-splitting the joined prose. Contributions with
* `interpolate: false` preserve literal text instead of resolving prompt variables.
* @param assembly - the assembly whose contexts and variables to render.
* @returns one entry per contributing context that rendered to non-empty text.
*/
function renderContextSections(assembly) {
	return assembly.contexts.map((context) => ({
		name: context.name,
		text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, "context")
	})).filter((section) => section.text.length > 0);
}
/** Interpolate one section or context and attribute diagnostics to its owning input. */
function interpolate(input, variables, kind) {
	const text = input.text;
	let result = "";
	let last = 0;
	for (let open = text.indexOf("{{"); open >= 0; open = text.indexOf("{{", last)) {
		const group = GROUP_AT.exec(text.slice(open));
		if (group === null) {
			if (text.indexOf("}}", open + 2) >= 0) throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`);
			result += text.slice(last, open + 2);
			last = open + 2;
			continue;
		}
		const name = group[0].slice(2, -2);
		if (!VARIABLE_NAME.test(name)) throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`);
		if (!Object.hasOwn(variables, name)) {
			const known = Object.keys(variables);
			throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(", ") : "(none)"}`);
		}
		const value = variables[name];
		if (value === void 0) throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`);
		result += text.slice(last, open) + value;
		last = open + group[0].length;
	}
	return result + text.slice(last);
}

export {renderPrompt,renderContextSections,joinContextSections};
