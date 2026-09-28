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
