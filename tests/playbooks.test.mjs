import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import { PLAYBOOK_TITLES, PLAYBOOK_TOPICS, PLAYBOOKS } from '../dist/playbooks.js';
import { SERVER_INSTRUCTIONS } from '../dist/instructions.js';

// The full tool set the guidance layer is written for. A name in a playbook,
// prompt or the instructions that is not here is a typo or a tool that does
// not exist.
const PLANNED_TOOLS = new Set([
  'search_models', 'get_model_schema', 'recommend_model', 'explore', 'run_model',
  'wait_for_task', 'get_task', 'list_tasks', 'get_task_price', 'cancel_task',
  'kill_task', 'upload_file', 'search_docs',
  'get_account', 'get_playbook',
  'list_workflows', 'get_workflow', 'create_workflow', 'update_workflow',
  'clone_workflow', 'delete_workflow', 'run_workflow', 'wait_for_workflow_run',
  'resume_workflow_run', 'list_workflow_runs', 'save_workflow_from_agent',
  'send_agent_message', 'get_agent_message', 'get_agent_conversation',
  'cancel_agent_message', 'delete_agent_session', 'list_studio_results',
  'list_agent_templates', 'get_agent_template', 'list_agent_skills', 'deploy_agent',
  'list_my_agents', 'get_my_agent', 'control_agent', 'update_agent',
  'manage_agent_billing', 'get_agent_activity', 'delete_agent',
  'apply_agent_skills', 'set_agent_credentials', 'connect_agent_oauth',
  'disconnect_agent_oauth', 'manage_agent_custom_skill',
]);

// snake_case words in the guidance that are parameters, actions or LLM segment
// names rather than tools.
const NON_TOOL_IDENTIFIERS = new Set([
  'timeout_seconds', 'wait_seconds', 'call_id', 'function_call', 'custom_tool_call',
  'upgrade_to_pro', 'buy_credits', 'select_accounts', 'confirm_charge_usd', 'idempotency_key', 'redirect_url',
  'session_id', 'debug_node_id',
  // An example Start field key.
  'product_photo',
]);

const PROMPT_ARGUMENTS = {
  build_workflow: { goal: 'turn a product photo into a short ad video' },
  deploy_agent: { goal: 'post our blog articles to LinkedIn every Monday' },
  create_with_studio: { request: 'three square product shots of a ceramic mug' },
  talk_to_my_agent: { agent_name: 'Blog poster', message: 'What did you post this week?' },
};

async function withClient(callback, options) {
  const server = createMcpServer({}, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function snakeCaseWords(text) {
  return [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map(match => match[0]);
}

async function guidanceTexts(client) {
  const texts = Object.entries(PLAYBOOKS).map(([topic, markdown]) => [`playbook ${topic}`, markdown]);
  texts.push(['server instructions', SERVER_INSTRUCTIONS]);

  const { prompts } = await client.listPrompts();
  for (const prompt of prompts) {
    texts.push([`prompt ${prompt.name} description`, prompt.description ?? '']);
    const rendered = await client.getPrompt({ name: prompt.name, arguments: PROMPT_ARGUMENTS[prompt.name] });
    for (const message of rendered.messages) {
      texts.push([`prompt ${prompt.name}`, message.content.text]);
    }
  }

  const { tools } = await client.listTools();
  const playbookTool = tools.find(tool => tool.name === 'get_playbook');
  texts.push(['get_playbook description', playbookTool?.description ?? '']);
  return texts;
}

test('every playbook topic has a titled guide of readable length', () => {
  assert.deepEqual(Object.keys(PLAYBOOKS).sort(), [...PLAYBOOK_TOPICS].sort());
  for (const topic of PLAYBOOK_TOPICS) {
    const markdown = PLAYBOOKS[topic];
    assert.equal(typeof markdown, 'string', topic);
    assert.ok(markdown.trim().length > 0, `${topic} is empty`);
    assert.ok(markdown.startsWith('# '), `${topic} must start with a heading`);
    assert.ok(PLAYBOOK_TITLES[topic].length > 0, `${topic} has no title`);
    const lines = markdown.trimEnd().split('\n').length;
    assert.ok(lines >= 50 && lines <= 180, `${topic} has ${lines} lines`);
  }
});

test('the guidance layer never uses em or en dashes', async () => {
  await withClient(async client => {
    for (const [label, text] of await guidanceTexts(client)) {
      assert.equal(text.includes('\u2014'), false, `${label} contains an em dash`);
      assert.equal(text.includes('\u2013'), false, `${label} contains an en dash`);
    }
  });
});

test('every tool named in playbooks, prompts and instructions is in the planned tool set', async () => {
  await withClient(async client => {
    for (const [label, text] of await guidanceTexts(client)) {
      for (const word of snakeCaseWords(text)) {
        assert.ok(
          PLANNED_TOOLS.has(word) || NON_TOOL_IDENTIFIERS.has(word),
          `${label} mentions "${word}", which is not a planned tool`,
        );
      }
    }
  });
});

test('every planned tool is covered by at least one playbook', () => {
  const allPlaybooks = Object.values(PLAYBOOKS).join('\n');
  const missing = [...PLANNED_TOOLS].filter(name => !allPlaybooks.includes(`\`${name}\``));
  assert.deepEqual(missing, []);
});

test('the workflow examples are valid graphs that reference only declared sources', () => {
  const blocks = [...PLAYBOOKS['workflow-graph'].matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]);
  assert.equal(blocks.length, 2);

  const minimal = JSON.parse(blocks[0]);
  const videoStep = JSON.parse(`{${blocks[1]}}`)['node-video'];
  assert.equal(minimal.version, '1');
  assert.deepEqual(minimal.output, minimal.nodes.output.fields);
  assert.deepEqual(minimal.schema.output, {});

  for (const [key, node] of Object.entries({ ...minimal.nodes, 'node-video': videoStep })) {
    assert.equal(node.id, key);
    if (key === 'output') {
      assert.equal(node.type, 'display');
      assert.deepEqual(node.input, {});
      continue;
    }
    assert.match(key, /^node-[A-Za-z0-9_-]{1,64}$/);
    assert.equal(node.type, 'run');
    for (const value of Object.values(node.input)) {
      const ref = /^\$(input|node-[A-Za-z0-9_-]+)\./.exec(value);
      assert.ok(ref, `${key} input ${value} is not a reference`);
      assert.ok(node.depends.includes(ref[1]), `${key} must depend on ${ref[1]}`);
    }
  }

  // Wiro fills in the rest of a Start field the way the wiro.ai editor does,
  // so the example sends only the keys that count.
  for (const field of Object.values(minimal.schema.input)) {
    assert.deepEqual(Object.keys(field).sort(), ['defaultValue', 'label', 'type', 'ui']);
  }
});

test('get_playbook returns the requested topics as text and structured content', async () => {
  await withClient(async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'get_playbook');
    assert.ok(tool, 'get_playbook is not registered');
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.ok(tool.outputSchema);
    for (const topic of PLAYBOOK_TOPICS) {
      assert.ok(tool.description.includes(topic), `description does not list ${topic}`);
    }
    assert.match(tool.description, /before a multi-step job/);

    const result = await client.callTool({
      name: 'get_playbook',
      arguments: { topics: ['workflows', 'billing', 'workflows'] },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      result.structuredContent.topics.map(entry => entry.topic),
      ['workflows', 'billing'],
    );
    const [workflows, billing] = result.structuredContent.topics;
    assert.equal(workflows.title, PLAYBOOK_TITLES.workflows);
    assert.equal(workflows.markdown, PLAYBOOKS.workflows);
    assert.equal(billing.markdown, PLAYBOOKS.billing);
    assert.ok(result.content[0].text.includes(PLAYBOOK_TITLES.workflows));
    assert.ok(result.content[0].text.includes(PLAYBOOK_TITLES.billing));
  });
});

test('get_playbook refuses an empty or unknown topic list', async () => {
  await withClient(async client => {
    const empty = await client.callTool({ name: 'get_playbook', arguments: { topics: [] } });
    assert.equal(empty.isError, true);

    const unknown = await client.callTool({ name: 'get_playbook', arguments: { topics: ['pricing'] } });
    assert.equal(unknown.isError, true);
  });
});

test('the four prompts are listed and render a plan that starts from a playbook', async () => {
  await withClient(async client => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map(prompt => prompt.name).sort(),
      ['build_workflow', 'create_with_studio', 'deploy_agent', 'talk_to_my_agent'],
    );

    const argumentsOf = name => prompts.find(prompt => prompt.name === name).arguments;
    assert.deepEqual(argumentsOf('build_workflow').map(arg => [arg.name, arg.required]), [['goal', true]]);
    assert.deepEqual(argumentsOf('deploy_agent').map(arg => [arg.name, arg.required]), [['goal', true]]);
    assert.deepEqual(argumentsOf('create_with_studio').map(arg => [arg.name, arg.required]), [['request', true]]);
    assert.deepEqual(
      argumentsOf('talk_to_my_agent').map(arg => [arg.name, arg.required]),
      [['agent_name', false], ['message', false]],
    );

    const expectations = {
      build_workflow: ['create_workflow', 'run_workflow', '"workflows"'],
      deploy_agent: ['deploy_agent', 'confirm: true', '"agents"'],
      create_with_studio: ['list_studio_results', '$10', '"studio"'],
      talk_to_my_agent: ['list_my_agents', 'send_agent_message', '"agents"'],
    };
    for (const [name, args] of Object.entries(PROMPT_ARGUMENTS)) {
      const rendered = await client.getPrompt({ name, arguments: args });
      assert.equal(rendered.messages.length, 1);
      const [message] = rendered.messages;
      assert.equal(message.role, 'user');
      assert.equal(message.content.type, 'text');
      const text = message.content.text;
      assert.ok(text.includes(Object.values(args)[0]), `${name} does not state the goal`);
      assert.ok(text.includes('get_playbook'), `${name} does not send the assistant to a playbook`);
      assert.match(text, /confirm/i, `${name} does not ask to confirm charges`);
      for (const expected of expectations[name]) {
        assert.ok(text.includes(expected), `${name} should mention ${expected}`);
      }
    }

    const bare = await client.getPrompt({ name: 'talk_to_my_agent', arguments: {} });
    assert.match(bare.messages[0].content.text, /ask me which one/);
    assert.match(bare.messages[0].content.text, /ask me what to send/);
  });
});

test('the server advertises short instructions that point to the playbooks', async () => {
  await withClient(async client => {
    const instructions = client.getInstructions();
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.ok(instructions.split('\n').length <= 25);
    for (const phrase of ['get_playbook', 'error result', 'confirm: true', 'nextAction', 'resubmit']) {
      assert.ok(instructions.includes(phrase), `instructions should mention ${phrase}`);
    }
  });
});

// Every combination of toolsets a server can be started with.
const TOOLSET_CHOICES = [
  ['models'], ['workflows'], ['agents'],
  ['models', 'workflows'], ['models', 'agents'], ['workflows', 'agents'],
  ['models', 'workflows', 'agents'],
];

function expectedPrompts(toolsets) {
  const names = [];
  if (toolsets.includes('workflows')) names.push('build_workflow');
  if (toolsets.includes('agents')) names.push('deploy_agent');
  if (toolsets.includes('agents') || toolsets.includes('workflows')) names.push('create_with_studio');
  if (toolsets.includes('agents')) names.push('talk_to_my_agent');
  return names.sort();
}

test('prompts are offered only when every tool they name is loaded', async () => {
  for (const toolsets of TOOLSET_CHOICES) {
    await withClient(async client => {
      const label = toolsets.join(',');
      const registered = new Set((await client.listTools()).tools.map(tool => tool.name));
      const expected = expectedPrompts(toolsets);
      if (expected.length === 0) {
        assert.equal(client.getServerCapabilities()?.prompts, undefined, `${label} should offer no prompts`);
        return;
      }
      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map(prompt => prompt.name).sort(), expected, label);
      for (const prompt of prompts) {
        const rendered = await client.getPrompt({ name: prompt.name, arguments: PROMPT_ARGUMENTS[prompt.name] });
        for (const word of snakeCaseWords(rendered.messages[0].content.text)) {
          if (!PLANNED_TOOLS.has(word)) continue;
          assert.ok(registered.has(word), `${prompt.name} names ${word}, which ${label} does not load`);
        }
      }
    }, { toolsets });
  }
});

test('Studio results can be collected wherever Studio can be reached', async () => {
  for (const toolsets of TOOLSET_CHOICES) {
    await withClient(async client => {
      const names = new Set((await client.listTools()).tools.map(tool => tool.name));
      assert.equal(names.has('list_studio_results'), names.has('send_agent_message'), toolsets.join(','));
    }, { toolsets });
  }
});

test('Workflow Agent proposals can be saved wherever the Workflow Agent can be reached', async () => {
  for (const toolsets of TOOLSET_CHOICES) {
    await withClient(async client => {
      const names = new Set((await client.listTools()).tools.map(tool => tool.name));
      assert.equal(names.has('save_workflow_from_agent'), names.has('send_agent_message'), toolsets.join(','));
    }, { toolsets });
  }
});

test('the instructions say what to do when a toolset leaves out a tool they name', async () => {
  const named = [...new Set(snakeCaseWords(SERVER_INSTRUCTIONS))].filter(word => PLANNED_TOOLS.has(word));
  for (const toolsets of TOOLSET_CHOICES) {
    await withClient(async client => {
      const registered = new Set((await client.listTools()).tools.map(tool => tool.name));
      const missing = named.filter(name => !registered.has(name));
      if (missing.length === 0) return;
      const instructions = client.getInstructions();
      const label = `${toolsets.join(',')} leaves out ${missing.join(', ')}`;
      assert.match(instructions, /can load only some tool groups/, label);
      assert.match(instructions, /or in a nextAction is not in your tool list, it is not available: tell the user/, label);
    }, { toolsets });
  }
  assert.match(PLAYBOOKS['getting-started'], /or in a `nextAction` is not in your tool list, its group is not loaded: tell the user/);
});

// deploy_agent and manage_agent_billing confirm with confirm_charge_usd, but
// apply_agent_skills confirms with the quote's idempotency_key. General money
// guidance must give both, or it sends a skill change down the wrong path.
test('the general money guidance never gives confirm_charge_usd as the only quote reference', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const sectionOf = (markdown, heading) => markdown.split(heading)[1].split(/\n#{2,3} /)[0];
  const passages = [
    ['server instructions', SERVER_INSTRUCTIONS],
    ['getting-started money rules', sectionOf(PLAYBOOKS['getting-started'], '## Money rules')],
    ['billing playbook', PLAYBOOKS.billing],
    ['README paid actions', sectionOf(readme, '### Paid and irreversible actions')],
  ];
  for (const [label, text] of passages) {
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=\.) (?=\S)/)
      .filter(sentence => sentence.includes('confirm_charge_usd'));
    assert.ok(sentences.some(sentence => sentence.includes('idempotency_key')), `${label} does not name both quote references`);
    for (const sentence of sentences) {
      // A sentence only about a deploy or a billing action such as the Pro upgrade may name confirm_charge_usd alone.
      if (/deploy|manage_agent_billing|upgrade/i.test(sentence) && !/skill/i.test(sentence)) continue;
      assert.ok(sentence.includes('idempotency_key'), `${label} gives confirm_charge_usd alone: "${sentence}"`);
    }
  }
});

test('the instructions and the money rules name every tool that asks for confirm', async () => {
  const confirmLines = SERVER_INSTRUCTIONS.split('\n').filter(line => line.includes('confirm: true'));
  const moneyRules = PLAYBOOKS['getting-started'].split('## Money rules')[1].split('\n## ')[0];
  await withClient(async client => {
    for (const tool of (await client.listTools()).tools) {
      const properties = tool.inputSchema?.properties ?? {};
      if (!Object.hasOwn(properties, 'confirm')) continue;
      assert.ok(confirmLines.some(line => line.includes(tool.name)), `the instructions do not say that ${tool.name} takes confirm`);
      assert.ok(moneyRules.includes(`\`${tool.name}\``), `the money rules do not say that ${tool.name} takes confirm`);
      if (Object.hasOwn(properties, 'confirm_charge_usd')) {
        const chargeLine = confirmLines.find(line => line.includes('confirm_charge_usd'));
        assert.ok(chargeLine?.includes(tool.name), `the instructions do not tie ${tool.name} to confirm_charge_usd`);
      }
    }
  });
});

test('the guidance and the README make no stale promises', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  await withClient(async client => {
    const texts = [...await guidanceTexts(client), ['README', readme]];
    for (const [label, text] of texts) {
      // A template's list price is exact; a quote for a prorated change is not.
      assert.doesNotMatch(text, /exact (USD )?amount|return the exact price/i, `${label} calls a quote exact`);
      assert.doesNotMatch(text, /200 MB/, `${label} states the old upload limit`);
      assert.doesNotMatch(text, /checkout/i, `${label} mentions a checkout page`);
      assert.doesNotMatch(text, /credit[^.\n]*expir|expir[^.\n]*credit/i, `${label} mentions credit expiry`);
    }
  });
  assert.equal(readme.includes('\u2014'), false, 'README contains an em dash');
  assert.equal(readme.includes('\u2013'), false, 'README contains an en dash');
  const oauthRow = readme.split('\n').find(line => line.startsWith('| `connect_agent_oauth`'));
  assert.ok(oauthRow, 'README has no connect_agent_oauth row');
  assert.doesNotMatch(oauthRow, /gmail/i, 'Gmail connects with an app password, not a sign-in');
});
