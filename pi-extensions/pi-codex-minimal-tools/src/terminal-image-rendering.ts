const ESC = "\x1b";
const KITTY_GRAPHICS_START = `${ESC}_G`;
const STRING_TERMINATOR = `${ESC}\\`;
const KITTY_PLACEHOLDER = "\u{10EEEE}";
const ROW_COLUMN_DIACRITICS = [
	0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A, 0x034B, 0x034C, 0x0350, 0x0351, 0x0352, 0x0357,
	0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484,
	0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
	0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
	0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8, 0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
	0x06E4, 0x06E7, 0x06E8, 0x06EB, 0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
	0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3, 0x0816, 0x0817, 0x0818, 0x0819,
	0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C,
].map((codePoint) => String.fromCodePoint(codePoint));

export interface KittyPlaceholderOptions {
	columns: number;
	rows: number;
	imageId: number;
}

export function tmuxPassthroughWrap(sequence: string): string {
	return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${STRING_TERMINATOR}`;
}

export function wrapKittyGraphicsForTmux(line: string): string {
	if (!process.env.TMUX || !line.includes(KITTY_GRAPHICS_START)) return line;
	let result = "";
	let offset = 0;
	while (offset < line.length) {
		const start = line.indexOf(KITTY_GRAPHICS_START, offset);
		if (start === -1) {
			result += line.slice(offset);
			break;
		}
		const end = line.indexOf(STRING_TERMINATOR, start + KITTY_GRAPHICS_START.length);
		if (end === -1) {
			result += line.slice(offset);
			break;
		}
		const sequenceEnd = end + STRING_TERMINATOR.length;
		result += line.slice(offset, start);
		result += tmuxPassthroughWrap(line.slice(start, sequenceEnd));
		offset = sequenceEnd;
	}
	return result;
}

export function encodeKittyVirtualPlacement(base64Data: string, options: KittyPlaceholderOptions): string {
	const chunkSize = 4096;
	const params = ["a=T", "f=100", "q=2", "U=1", `c=${options.columns}`, `r=${options.rows}`, `i=${options.imageId}`];
	if (base64Data.length <= chunkSize) return `${KITTY_GRAPHICS_START}${params.join(",")};${base64Data}${STRING_TERMINATOR}`;
	const chunks: string[] = [];
	for (let offset = 0, first = true; offset < base64Data.length; offset += chunkSize, first = false) {
		const chunk = base64Data.slice(offset, offset + chunkSize);
		const last = offset + chunkSize >= base64Data.length;
		if (first) chunks.push(`${KITTY_GRAPHICS_START}${params.join(",")},m=1;${chunk}${STRING_TERMINATOR}`);
		else chunks.push(`${KITTY_GRAPHICS_START}m=${last ? 0 : 1};${chunk}${STRING_TERMINATOR}`);
	}
	return chunks.join("");
}

export function kittyPlaceholderCell(row: number, column: number): string {
	const rowMark = ROW_COLUMN_DIACRITICS[row];
	const columnMark = ROW_COLUMN_DIACRITICS[column];
	if (!rowMark || !columnMark) throw new Error(`Kitty placeholder cell out of range: row ${row}, column ${column}`);
	return `${KITTY_PLACEHOLDER}${rowMark}${columnMark}`;
}

export function kittyPlaceholderRows(options: KittyPlaceholderOptions): string[] {
	const id = Math.max(1, Math.min(0xffffffff, Math.floor(options.imageId)));
	const red = (id >>> 16) & 0xff;
	const green = (id >>> 8) & 0xff;
	const blue = id & 0xff;
	const start = `${ESC}[38;2;${red};${green};${blue}m`;
	const end = `${ESC}[39m`;
	const rows: string[] = [];
	for (let row = 0; row < options.rows; row++) {
		let line = start;
		for (let column = 0; column < options.columns; column++) line += kittyPlaceholderCell(row, column);
		rows.push(line + end);
	}
	return rows;
}

export function renderTmuxKittyPlaceholderImage(base64Data: string, options: KittyPlaceholderOptions): string[] {
	const transfer = tmuxPassthroughWrap(encodeKittyVirtualPlacement(base64Data, options));
	const rows = kittyPlaceholderRows(options);
	if (rows.length === 0) return [];
	rows[0] = transfer + rows[0];
	return rows;
}
