/**
 * 冒烟测试 —— 不连网、不消耗 WorkBuddy 额度。
 *
 * 用假的 ctx 跑一遍 apply()，确认：
 *   1. 三个工具都注册上了，且名字/参数/输出 schema 合规
 *   2. render 返回的是 ContentBlock 数组（返回字符串会在 dsh-spill-policy 里炸）
 *   3. 参数校验能挡住缺参和错类型
 *   4. 列专家 / 自检 两个只读工具真的能跑出内容
 *
 * 运行：node --test test/   或   node test/plugin-smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, name, inject } from '../index.mjs';

/** 最小 ctx 替身：只要 logger 和 tools.register。 */
function fakeCtx() {
  const registered = [];
  return {
    registered,
    logger: () => ({ warn() {}, info() {}, debug() {} }),
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
  };
}

function mount(rowConfig) {
  const ctx = fakeCtx();
  apply(ctx, rowConfig);
  const byName = new Map(ctx.registered.map(d => [d.name, d]));
  return { ctx, byName };
}

test('插件元数据合规', () => {
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0);
  assert.deepEqual(inject, ['tools']);
});

test('注册了三个工具，名字唯一且都以 workbuddy_ 开头', () => {
  const { ctx, byName } = mount();
  assert.equal(ctx.registered.length, 3);
  assert.deepEqual([...byName.keys()].sort(), [
    'workbuddy_list_experts',
    'workbuddy_run',
    'workbuddy_status',
  ]);
  for (const def of ctx.registered) {
    assert.match(def.name, /^workbuddy_/, `${def.name} 前缀不对`);
    assert.ok(def.description.length > 40, `${def.name} 的 description 太短，模型读不出用途`);
    assert.equal(def.parameters && typeof def.parameters, 'object');
    assert.ok(def.output?.schema, `${def.name} 缺 output.schema`);
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output.render, 'function');
  }
});

test('parameters 是合法 JSON Schema（根必须是 type:object）', () => {
  const { ctx } = mount();
  for (const def of ctx.registered) {
    // 宿主会把 parameters 原样送进 tools[].function.parameters。
    // 根上少了 type:'object'，接口会拒掉整个请求（got 'type': null），
    // 而且每一轮都会带上这个工具 —— 整个会话直接写死。
    assert.equal(def.parameters.type, 'object', `${def.name} 的 parameters 根节点缺 type:object`);
    assert.ok(def.parameters.properties && typeof def.parameters.properties === 'object');
    if (def.parameters.required !== undefined) {
      assert.ok(Array.isArray(def.parameters.required), `${def.name} 的 required 必须是数组`);
      for (const key of def.parameters.required) {
        assert.ok(key in def.parameters.properties, `${def.name} 的 required 指向不存在的属性 ${key}`);
      }
    }
    for (const [key, prop] of Object.entries(def.parameters.properties)) {
      assert.equal(typeof prop, 'object', `${def.name}.${key} 不是 schema 对象`);
      assert.ok('type' in prop, `${def.name}.${key} 缺 type`);
      // 属性级 required 是布尔，那是我们自己的方言，不能漏进 JSON Schema
      assert.equal(typeof prop.required, 'undefined', `${def.name}.${key} 残留了方言字段 required`);
    }
  }
});

test('每个工具的 render 都返回 ContentBlock 数组', () => {
  const { ctx } = mount();
  for (const def of ctx.registered) {
    const rendered = def.output.render({}, { ok: true, text: 'hello' });
    assert.ok(Array.isArray(rendered), `${def.name} 的 render 没返回数组（会触发 content.some is not a function）`);
    assert.ok(rendered.length > 0);
    assert.equal(rendered[0].type, 'text');
    assert.equal(typeof rendered[0].text, 'string');
  }
});

test('workbuddy_run 缺必填参数时返回 ok:false 而不是抛异常', async () => {
  const { byName } = mount();
  const run = byName.get('workbuddy_run');

  const noExpert = await run.execute({ task: '做点什么' }, { signal: undefined });
  assert.equal(noExpert.ok, false);
  assert.match(noExpert.text, /expert/);

  const noTask = await run.execute({ expert: 'ppt-implement' }, { signal: undefined });
  assert.equal(noTask.ok, false);
  assert.match(noTask.text, /task/);

  const badType = await run.execute({ expert: 123, task: 'x' }, { signal: undefined });
  assert.equal(badType.ok, false);
});

test('workbuddy_list_experts 能列出本地专家', async () => {
  const { byName } = mount();
  const list = byName.get('workbuddy_list_experts');
  const result = await list.execute({}, { signal: undefined });

  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0);
  assert.ok(Array.isArray(result.experts));
  // 本地至少装了 ppt-implement（PoC 阶段已确认）；没有也不该崩
  if (result.experts.length > 0) {
    const first = result.experts[0];
    assert.equal(typeof first.name, 'string');
    assert.equal(typeof first.dir, 'string');
    assert.match(result.text, /workbuddy_run/);
  }
});

test('workbuddy_status 能跑完并给出结论', async () => {
  const { byName } = mount();
  const status = byName.get('workbuddy_status');
  const result = await status.execute({}, { signal: undefined });

  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.checks));
  assert.ok(result.checks.length >= 5);
  assert.match(result.text, /结论/);
});
