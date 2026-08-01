import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTaskPending,
  formatTaskResult,
} from '../dist/utils/format.js';

test('formatTaskResult renders image outputs directly in chat', () => {
  const text = formatTaskResult({
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: '',
    starttime: '',
    endtime: '',
    elapsedseconds: '4',
    totalcost: '0.01',
    outputs: [{
      name: 'result.png',
      contenttype: 'image/png',
      size: '2048',
      url: 'https://cdn.example/result.png',
    }],
  });

  assert.match(text, /\*\*Result:\*\* Success/);
  assert.match(text, /!\[result\.png\]\(https:\/\/cdn\.example\/result\.png\)/);
  assert.match(text, /\[Open image\]\(https:\/\/cdn\.example\/result\.png\)/);
});

test('formatTaskResult distinguishes fatal DB task errors', () => {
  const text = formatTaskResult({
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_error',
    pexit: '',
    debugoutput: '',
    debugerror: 'User has no output folder',
    starttime: '',
    endtime: '',
    elapsedseconds: '0',
    totalcost: '0',
    outputs: [],
  });

  assert.match(text, /Failed before model execution/);
  assert.match(text, /User has no output folder/);
});

test('formatTaskPending tells the assistant to resume instead of rerun', () => {
  const text = formatTaskPending({
    taskid: '123',
    tasktoken: 'task-token',
    status: 'task_start',
    timeoutSeconds: 45,
  });

  assert.match(text, /wait_for_task/);
  assert.match(text, /Do not call `run_model` again/);
  assert.match(text, /task-token/);
});
