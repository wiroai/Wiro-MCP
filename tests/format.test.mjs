import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTaskList,
  formatTaskPending,
  formatTaskResult,
} from '../dist/utils/format.js';
import { createTaskContent } from '../dist/utils/structured.js';

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

test('completed media asks the assistant to present resource links to the user', () => {
  const content = createTaskContent('Task complete.', {
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

  const deliveryInstruction = content.find(block => block.type === 'text'
    && block.annotations?.audience?.includes('assistant'));
  const media = content.find(block => block.type === 'resource_link');

  assert.match(deliveryInstruction?.text ?? '', /Present every generated media output/);
  assert.deepEqual(deliveryInstruction?.annotations, {
    audience: ['assistant'],
    priority: 1,
  });
  assert.equal(media?.uri, 'https://cdn.example/result.png');
  assert.match(media?.description ?? '', /Present this media/);
  assert.deepEqual(media?.annotations, {
    audience: ['user', 'assistant'],
    priority: 1,
  });
});

test('running tasks do not ask the assistant to present unfinished media', () => {
  const content = createTaskContent('Task running.', {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_start',
    pexit: '',
    debugoutput: '',
    starttime: '',
    endtime: '',
    elapsedseconds: '4',
    totalcost: '0.01',
    outputs: [],
  });

  assert.equal(content.some(block => block.type === 'text'
    && block.annotations?.audience?.includes('assistant')), false);
});

test('formatTaskResult keeps DB task_error non-terminal', () => {
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

  assert.doesNotMatch(text, /\*\*Result:\*\*/);
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

test('formatTaskList keeps history concise and points to get_task', () => {
  const text = formatTaskList([{
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: { prompt: 'must not be rendered' },
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: 'must not be rendered',
    starttime: '2026-08-01T10:00:00Z',
    endtime: '2026-08-01T10:00:04Z',
    elapsedseconds: '4',
    totalcost: '0.01',
    modelslugowner: 'owner',
    modelslugproject: 'model',
    outputs: [{
      name: 'result.png',
      contenttype: 'image/png',
      size: '2048',
      url: 'https://cdn.example/result.png',
    }],
  }], 1, 0);

  assert.match(text, /Task History \(1 total\)/);
  assert.match(text, /owner\/model/);
  assert.match(text, /get_task/);
  assert.doesNotMatch(text, /must not be rendered/);
});
