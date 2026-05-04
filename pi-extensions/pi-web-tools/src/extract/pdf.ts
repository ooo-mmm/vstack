export interface PdfExtractionResult {
	text: string;
	metadata: Record<string, unknown>;
}

function decodePdfLiteral(input: string): string {
	return input
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\\(/g, "(")
		.replace(/\\\)/g, ")")
		.replace(/\\\\/g, "\\");
}

export function extractPdfText(buffer: ArrayBuffer | Uint8Array | string): PdfExtractionResult {
	const binary = typeof buffer === "string" ? buffer : Buffer.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)).toString("latin1");
	const chunks: string[] = [];
	for (const match of binary.matchAll(/\(([^()]{2,})\)\s*T[jJ]/g)) chunks.push(decodePdfLiteral(match[1] ?? ""));
	for (const match of binary.matchAll(/\[([^\]]+)\]\s*TJ/g)) {
		const segment = match[1] ?? "";
		const parts = [...segment.matchAll(/\(([^()]*)\)/g)].map((item) => decodePdfLiteral(item[1] ?? ""));
		if (parts.length) chunks.push(parts.join(""));
	}
	const text = chunks.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
	if (!text) throw new Error("PDF text extraction found no embedded text. Use OCR or a provider fallback for scanned PDFs.");
	return { text, metadata: { extraction: "pdf-basic", chunks: chunks.length } };
}

export async function fetchPdfText(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<PdfExtractionResult> {
	const response = await fetchImpl(url, { signal });
	if (!response.ok) throw new Error(`PDF fetch failed (${response.status}) for ${url}`);
	return extractPdfText(await response.arrayBuffer());
}
