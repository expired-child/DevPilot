const VARIABLE_PATTERN = /{{\s*([a-zA-Z][\w.-]*)\s*}}/g;

export interface TemplateResult {
  value: string;
  missing: string[];
}

export const collectVariables = (values: string[]): string[] => {
  const variables = new Set<string>();

  for (const value of values) {
    for (const match of value.matchAll(VARIABLE_PATTERN)) {
      variables.add(match[1]);
    }
  }

  return [...variables];
};

export const renderTemplate = (template: string, variables: Record<string, string>): TemplateResult => {
  const missing = new Set<string>();
  const value = template.replace(VARIABLE_PATTERN, (placeholder, name: string) => {
    if (!(name in variables) || variables[name].trim() === '') {
      missing.add(name);
      return placeholder;
    }
    return variables[name];
  });

  return { value, missing: [...missing] };
};
