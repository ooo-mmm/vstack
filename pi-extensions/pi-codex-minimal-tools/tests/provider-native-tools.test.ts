import assert from "node:assert/strict";
import test from "node:test";
import { rewriteNativeOpenAiTools } from "../src/provider-native-tools.js";

test("rewriteNativeOpenAiTools rewrites function tools to native Responses tools", () => {
	const payload = {
		tools: [
			{ type: "function", name: "image_generation", parameters: { output_format: "webp" } },
			{ type: "function", function: { name: "web_search", parameters: {} } },
			{ type: "function", name: "read" },
		],
	};
	const result = rewriteNativeOpenAiTools(payload);
	assert.deepEqual(result.rewritten, ["image_generation", "web_search"]);
	assert.deepEqual(result.payload.tools[0], { type: "image_generation", output_format: "webp" });
	assert.deepEqual(result.payload.tools[1], { type: "web_search", external_web_access: true });
	assert.equal((result.payload.tools[2] as any).name, "read");
});

test("rewriteNativeOpenAiTools honors external web access setting", () => {
	const result = rewriteNativeOpenAiTools({ tools: [{ type: "function", name: "web_search" }] }, { webSearchExternalAccess: false });
	assert.deepEqual(result.payload.tools[0], { type: "web_search", external_web_access: false });
});
