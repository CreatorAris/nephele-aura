const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/(tabs)/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'remoteWS.onMessage') {
        const candidate = node.arguments[0];
        if (candidate.getText(ast).includes("msg.action !== 'board_send_result'")) handler = candidate;
    }
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler, 'production board result handler must exist');
const compiled = ts.transpileModule(`const handler = ${handler.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
function receive(initial, data, uploadFailures = 0, requestId = 'board-test') {
    let state = initial;
    const context = {
        boardSendReqRef: { current: requestId },
        uploadFailedRef: { current: uploadFailures },
        setImportState: update => { state = update(state); },
    };
    vm.createContext(context);
    vm.runInContext(compiled + '\nglobalThis.receive = handler;', context);
    context.receive({ type: 'event', action: 'board_send_result', data });
    return { state: JSON.parse(JSON.stringify(state)), requestId: context.boardSendReqRef.current };
}
const importing = total => ({ stage: 'importing', total, uploaded: total, progress: 0, failed: 0 });
assert.deepEqual(receive(importing(10), {
    requestId: 'board-test', added: 0, already: 0, failed: [{ error: 'Board target expired or changed' }],
}), { state: { stage: 'done', processed: 0, failed: 10, total: 10 }, requestId: '' });
assert.deepEqual(receive(importing(10), {
    requestId: 'board-test', added: 6, already: 1, failed: [{ error: 'download failed' }],
}, 2).state, { stage: 'done', processed: 7, failed: 3, total: 10 });
assert.deepEqual(receive({ stage: 'unknown', total: 10 }, {
    requestId: 'board-test', added: 0, already: 0, failed: [{ error: 'batch rejected' }],
}).state, { stage: 'done', processed: 0, failed: 10, total: 10 });
assert.deepEqual(receive(importing(10), {
    requestId: 'unrelated', added: 10, already: 0, failed: [],
}), { state: importing(10), requestId: 'board-test' });
console.log('Board result handler: batch rejection, mixed failures, late result and unrelated request passed.');
