import chalk from "chalk";

export function printJson(value: unknown): never {
  console.log(JSON.stringify(value, null, 2));
  process.exit(0);
}

export function printTable(
  headers: string[],
  rows: string[][]
): void {
  const colWidths = headers.map((h, i) => {
    const maxRowWidth = Math.max(0, ...rows.map((r) => r[i]?.length ?? 0));
    return Math.max(h.length, maxRowWidth);
  });

  console.log(
    headers
      .map((h, i) => h.padEnd(colWidths[i] ?? 0))
      .join("  ")
  );
  console.log(
    colWidths
      .map((w) => "─".repeat(w ?? 0))
      .join("──")
  );

  for (const row of rows) {
    console.log(
      row.map((cell, i) => (cell ?? "").padEnd(colWidths[i] ?? 0)).join("  ")
    );
  }
}

export function die(message: string, code?: number): never {
  console.error(chalk.red("error:"), message);
  process.exit(code ?? 1);
}

export function success(message: string): void {
  console.log(chalk.green("✓"), message);
}

export function warn(message: string): void {
  console.error(chalk.yellow("⚠"), message);
}
