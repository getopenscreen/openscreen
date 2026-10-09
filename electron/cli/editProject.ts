import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { documentSchema } from "../../src/lib/ai-edition/schema";

/** Validate before touching the destination; publish a complete project atomically. */
export async function saveEditedProject(filePath: string, raw: unknown): Promise<void> {
	const document = documentSchema.parse(raw);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		const handle = await fs.open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(document, null, 2), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		// Windows indexers can briefly hold an otherwise writable destination.
		for (let attempt = 0; ; attempt++) {
			try {
				await fs.rename(temporaryPath, filePath);
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt >= 5 || !code || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
				await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
			}
		}
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}
