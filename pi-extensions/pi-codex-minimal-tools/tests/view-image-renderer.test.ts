import assert from "node:assert/strict";
import test from "node:test";
import { encodeKittyVirtualPlacement, kittyPlaceholderRows, renderTmuxKittyPlaceholderImage, tmuxPassthroughWrap, wrapKittyGraphicsForTmux } from "../src/terminal-image-rendering.js";

const ESC = "\x1b";

test("tmuxPassthroughWrap doubles ESC bytes and uses DCS tmux wrapper", () => {
	const wrapped = tmuxPassthroughWrap(`${ESC}_Ga=T;AAAA${ESC}\\`);
	assert.equal(wrapped, `${ESC}Ptmux;${ESC}${ESC}_Ga=T;AAAA${ESC}${ESC}\\${ESC}\\`);
});

test("tmux placeholder image rendering reserves terminal cells", () => {
	const rows = kittyPlaceholderRows({ columns: 3, rows: 2, imageId: 0x010207 });
	assert.equal(rows.length, 2);
	assert.ok(rows[0]?.startsWith(`${ESC}[38;2;1;2;7m`));
	assert.ok(rows[0]?.endsWith(`${ESC}[39m`));
	assert.equal([...rows[0]!.replace(`${ESC}[38;2;1;2;7m`, "").replace(`${ESC}[39m`, "")].filter((char) => char === "\u{10EEEE}").length, 3);

	const transfer = encodeKittyVirtualPlacement("AAAA", { columns: 3, rows: 2, imageId: 0x010207 });
	assert.match(transfer, /U=1/);
	assert.match(transfer, /c=3/);
	assert.match(transfer, /r=2/);
	assert.match(transfer, /i=66055/);

	const rendered = renderTmuxKittyPlaceholderImage("AAAA", { columns: 3, rows: 2, imageId: 0x010207 });
	assert.equal(rendered.length, 2);
	assert.ok(rendered[0]?.startsWith(`${ESC}Ptmux;`));
	assert.ok(rendered[0]?.includes("\u{10EEEE}"));
});

test("wrapKittyGraphicsForTmux wraps every Kitty graphics sequence only inside tmux", () => {
	const originalTmux = process.env.TMUX;
	try {
		delete process.env.TMUX;
		const line = `prefix${ESC}_Ga=T;one${ESC}\\middle${ESC}_Gm=0;two${ESC}\\suffix`;
		assert.equal(wrapKittyGraphicsForTmux(line), line);

		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const wrapped = wrapKittyGraphicsForTmux(line);
		assert.equal(wrapped, `prefix${ESC}Ptmux;${ESC}${ESC}_Ga=T;one${ESC}${ESC}\\${ESC}\\middle${ESC}Ptmux;${ESC}${ESC}_Gm=0;two${ESC}${ESC}\\${ESC}\\suffix`);
	} finally {
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
	}
});
