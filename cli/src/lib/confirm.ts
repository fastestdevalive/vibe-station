import prompts from "prompts";
import { die } from "./output.js";

export async function confirmByTypingName(
  name: string,
  warning: string
): Promise<void> {
  console.error(warning);
  const response = await prompts({
    type: "text",
    name: "confirm",
    message: `Type "${name}" to confirm:`,
  });

  if (response.confirm !== name) {
    die("Cancelled.", 1);
  }
}
