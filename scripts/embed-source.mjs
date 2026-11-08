// Compile the current production source for both media tests. Never reuse an
// ignored out-tmp artifact that may be missing or stale in a fresh checkout.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../uni_modules/qt-app-native/utssdk/embed-bytes.uts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  fileName: 'embed-bytes.ts',
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const bytes = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
export const { planMp3, planFlac, utf16leEncode, utf8Encode, base64Encode, base64Decode } = bytes;
