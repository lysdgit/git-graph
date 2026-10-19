/**
 * Ambient declarations for the standalone build.
 *
 * The extension sources are type-checked against Visual Studio Code's official type definitions
 * (`@types/vscode`) so that they compile exactly as they do upstream. At runtime the `vscode`
 * module is swapped for `src/adapter/vscode.ts`, which is why no type aliasing is needed here.
 *
 * `Thenable` is declared globally by `@types/vscode`; this file only exists to document that.
 */
