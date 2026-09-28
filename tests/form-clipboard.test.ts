import { afterEach, describe, expect, it } from 'vitest';
import { scanForm } from '../src/content/scanner/form-scanner';
import { applyFields } from '../src/content/apply-fields';
import { buildFillPlan } from '../src/modules/form-clipboard/fill-plan-service';
import type { FormClipboardItem } from '../src/modules/form-clipboard/clipboard-types';

afterEach(() => { document.body.replaceChildren(); });

const capture = (): FormClipboardItem => ({
  ...scanForm().result,
  id: 'test', name: 'test', createdAt: 0, updatedAt: 0, fingerprint: 'test',
});

describe('copy scope', () => {
  it('copies the open dialog even when the background form has many more fields', () => {
    document.body.innerHTML = `<main><form>${Array.from({ length: 12 }, (_, i) => `<input name="background${i}">`).join('')}</form></main>
      <div role="dialog"><form><input name="name" value="dialog value"></form></div>`;
    expect(scanForm().result.fields.map((field) => field.value)).toEqual(['dialog value']);
  });

  it('copies the focused form instead of a larger unrelated form', () => {
    document.body.innerHTML = '<main><form><input name="a"><input name="b"><input name="c"></form><form><input name="wanted" value="focused"></form></main>';
    document.querySelector<HTMLInputElement>('[name="wanted"]')!.focus();
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['wanted']);
  });

  it('does not fall back to the background when the dialog has no eligible fields', () => {
    document.body.innerHTML = '<form><input name="background"></form><div role="dialog"><input type="password" name="password"></div>';
    expect(scanForm().result.fields).toEqual([]);
  });

  it('copies account fields from a login form while excluding credentials', () => {
    document.body.innerHTML = `<form>
      <input name="accountId" value="account-123">
      <input name="username" value="user-a">
      <input name="credential" type="password" value="secret-value">
      <input name="verificationCode" value="123456">
      <button type="submit">登录</button>
    </form>`;
    expect(scanForm().result.fields.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'accountId', value: 'account-123' },
      { name: 'username', value: 'user-a' },
    ]);
  });

  it('excludes an unlabeled password even when the login controls have no form element', () => {
    document.body.innerHTML = '<div class="login"><input name="username" value="user-a"><input name="credential" type="password" value="secret-value"></div>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['username']);
  });

  it('retains a labeled business field displayed with a masked input', () => {
    document.body.innerHTML = '<form><label>联系电话<input name="maskedPhone" type="password" value="13800000000"></label></form>';
    expect(scanForm().result.fields.map((field) => field.value)).toEqual(['13800000000']);
  });

  it('does not treat a bank account field and masked phone as a login form', () => {
    document.body.innerHTML = '<form><input name="bankAccount" value="account-123"><label>联系电话<input name="maskedPhone" type="password" value="13800000000"></label></form>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['bankAccount', 'maskedPhone']);
  });

  it('keeps search inputs inside a business form', () => {
    document.body.innerHTML = '<form><input type="search" name="productCode" value="SKU-1"><input name="quantity" value="2"></form>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['productCode', 'quantity']);
  });

  it('copies a business form inside an aside panel', () => {
    document.body.innerHTML = '<aside><form><input name="itemName" value="Draft"></form></aside>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['itemName']);
  });

  it('excludes a verification code identified only by its label', () => {
    document.body.innerHTML = '<form><label>验证码<input name="code" value="123456"></label><input name="username" value="user-a"></form>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['username']);
  });

  it('keeps token count fields while excluding credential tokens', () => {
    document.body.innerHTML = '<form><input name="maxTokens" value="4096"><label>Token 上限<input name="tokenLimit" value="8192"></label><input name="accessToken" value="secret-value"><input name="secretaryName" value="Ada"></form>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['maxTokens', 'tokenLimit', 'secretaryName']);
  });

  it('keeps all sibling fields when a form has no native form element', () => {
    document.body.innerHTML = '<section class="settings"><div class="form-item"><input name="first" value="A"></div><div class="form-item"><input name="second" value="B"></div></section>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['first', 'second']);
  });

  it('keeps separate field groups apart when one group is focused', () => {
    document.body.innerHTML = '<section><div class="form-item"><input name="a1"></div><div class="form-item"><input name="a2"></div></section><section><div class="form-item"><input name="b1"></div><div class="form-item"><input name="b2"></div></section>';
    document.querySelector<HTMLInputElement>('[name="b1"]')!.focus();
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['b1', 'b2']);
  });

  it('does not copy an invisible text input inside a label', () => {
    document.body.innerHTML = '<form><label>Preview<input name="ghost" value="hidden" style="opacity:0"></label><input name="visible" value="shown"></form>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['visible']);
  });

  it('ignores label-wrapped fields inside hidden tabs', () => {
    document.body.innerHTML = '<form><div style="display:none"><label>Hidden<input name="hidden" value="wrong"></label></div><label>Visible<input name="visible" value="right"></label></form>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['visible']);
  });

  it('still includes a visually replaced checkbox in a visible label', () => {
    document.body.innerHTML = '<form><label>Enabled<input name="enabled" type="checkbox" checked style="opacity:0;width:0;height:0"></label></form>';
    expect(scanForm().result.fields.map((field) => field.value)).toEqual([true]);
  });

  it('copies the current empty input value, not its previous React default', () => {
    document.body.innerHTML = '<form><input name="name" value="old"></form>';
    const input = document.querySelector('input')!;
    Object.assign(input, { __reactProps$test: { defaultValue: 'old' } });
    input.value = '';
    expect(scanForm().result.fields[0].value).toBe('');
  });

  it('keeps a custom dropdown input when its wrapper is not a scan candidate', () => {
    document.body.innerHTML = '<form><div class="ehi-select"><input name="kind" value="Type A"></div></form>';
    expect(scanForm().result.fields.map((field) => field.value)).toEqual(['Type A']);
  });

  it('ignores a closed dialog and preserves the visible form', () => {
    document.body.innerHTML = '<dialog><label>Hidden<input name="hidden" value="wrong"></label></dialog><form><input name="visible" value="right"></form>';
    expect(scanForm().result.fields.map((field) => field.value)).toEqual(['right']);
  });

  it('does not merge multiple forms when there is no focused field', () => {
    document.body.innerHTML = '<main><form><input name="first"><input name="second"></form><form><input name="other"></form></main>';
    expect(scanForm().result.fields.map((field) => field.name)).toEqual(['first', 'second']);
  });

  it('does not let an irrelevant search form hide a custom business form', () => {
    document.body.innerHTML = '<form><input type="search"></form><main><input name="wanted" value="business"></main>';
    expect(scanForm().result.fields.map((field) => field.value)).toEqual(['business']);
  });
});

describe('copy and paste round trip', () => {
  it('keeps repeated names distinct and fills each row with its own value', async () => {
    document.body.innerHTML = '<form><label>Item<input name="item" value="first"></label><label>Item<input name="item" value="second"></label></form>';
    const item = capture();
    expect(new Set(item.fields.map((field) => field.key)).size).toBe(2);
    document.querySelectorAll('input').forEach((input) => { input.value = ''; });
    const plan = buildFillPlan(item, scanForm().result.fields);
    expect(plan.assignments).toHaveLength(2);
    expect(await applyFields(plan.assignments)).toMatchObject({ success: 2, failed: 0, skipped: 0 });
    expect([...document.querySelectorAll('input')].map((input) => input.value)).toEqual(['first', 'second']);
  });

  it('fills unnamed fields with unique structural selectors', async () => {
    document.body.innerHTML = '<form><input value="first"><input value="second"></form>';
    const item = capture();
    document.querySelectorAll('input').forEach((input) => { input.value = ''; });
    const plan = buildFillPlan(item, scanForm().result.fields);
    expect(plan.assignments).toHaveLength(2);
    await applyFields(plan.assignments);
    expect([...document.querySelectorAll('input')].map((input) => input.value)).toEqual(['first', 'second']);
  });

  it('finds a new live node after the preceding field triggers a rerender', async () => {
    document.body.innerHTML = '<form><input name="first"><input name="second"></form>';
    document.querySelector('[name="first"]')!.addEventListener('input', () => {
      const second = document.querySelector('[name="second"]')!;
      second.replaceWith(second.cloneNode());
    });
    const report = await applyFields([
      { targetKey: 'name:first', label: 'first', value: 'A' },
      { targetKey: 'name:second', label: 'second', value: 'B' },
    ]);
    expect(report).toMatchObject({ success: 2, failed: 0, skipped: 0 });
    expect(document.querySelector<HTMLInputElement>('[name="second"]')!.value).toBe('B');
  });

  it('does not report success when a rerender rejects the assigned value', async () => {
    document.body.innerHTML = '<form><input name="name"></form>';
    document.querySelector('input')!.addEventListener('input', () => {
      window.setTimeout(() => {
        const input = document.querySelector('input')!;
        const replacement = document.createElement('input');
        replacement.name = input.name;
        input.replaceWith(replacement);
      }, 0);
    });
    const report = await applyFields([{ targetKey: 'name:name', label: 'name', value: 'rejected' }]);
    expect(report).toMatchObject({ success: 0, failed: 1 });
  });

  it('keeps filling the original form after an adapter causes focus to leave it', async () => {
    document.body.innerHTML = '<form><input name="first"><input name="second"><input name="third"></form><form id="target"><input name="first"><input name="second"></form>';
    const first = document.querySelector<HTMLInputElement>('#target [name="first"]')!;
    first.focus();
    first.addEventListener('input', () => { first.blur(); });
    const assignments = scanForm().result.fields.map((field) => ({ targetKey: field.key, label: field.name!, value: 'filled' }));
    expect(await applyFields(assignments)).toMatchObject({ success: 2, failed: 0, skipped: 0 });
    expect([...document.querySelectorAll<HTMLInputElement>('#target input')].map((input) => input.value)).toEqual(['filled', 'filled']);
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
  });

  it('reports an earlier field being reset by a later field', async () => {
    document.body.innerHTML = '<form><input name="first"><input name="second"></form>';
    document.querySelector('[name="second"]')!.addEventListener('input', () => {
      document.querySelector<HTMLInputElement>('[name="first"]')!.value = '';
    });
    const report = await applyFields([
      { targetKey: 'name:first', label: 'first', value: 'A' },
      { targetKey: 'name:second', label: 'second', value: 'B' },
    ]);
    expect(report).toMatchObject({ success: 1, failed: 1, skipped: 0 });
    expect(report.issues[0].label).toBe('first');
  });

  it('preserves ordinary native text, checkbox, radio and select values', async () => {
    const form = '<form><label>Name<input name="name"></label><label>Enabled<input name="enabled" type="checkbox"></label><label>One<input name="choice" type="radio" value="one"></label><label>Two<input name="choice" type="radio" value="two"></label><label>Kind<select name="kind"><option value="a">A</option><option value="b">B</option></select></label></form>';
    document.body.innerHTML = form;
    document.querySelector<HTMLInputElement>('[name="name"]')!.value = 'example';
    document.querySelector<HTMLInputElement>('[name="enabled"]')!.checked = true;
    document.querySelector<HTMLInputElement>('[value="two"]')!.checked = true;
    document.querySelector<HTMLSelectElement>('select')!.value = 'b';
    const item = capture();
    document.body.innerHTML = form;
    const plan = buildFillPlan(item, scanForm().result.fields);
    expect(await applyFields(plan.assignments)).toMatchObject({ success: 4, skipped: 0, failed: 0 });
    expect(scanForm().result.fields.map((field) => field.value)).toEqual(['example', true, 'two', 'b']);
  });
});
