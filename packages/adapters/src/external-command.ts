import { execa } from "execa";

/** Execute an argv vector with execa's native Windows shim handling and no shell. */
export async function executeExternalCommand(file: string, args: readonly string[]): Promise<void> {
  await execa(file, [...args], { shell: false });
}
