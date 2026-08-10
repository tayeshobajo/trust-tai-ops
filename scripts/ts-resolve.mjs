// Lets the validation script use the app's extensionless relative imports
// under Node's native type stripping. Test tooling only.

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      return await nextResolve(`${specifier}.tsx`, context);
    }
  }
  return nextResolve(specifier, context);
}
