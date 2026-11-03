import { afterEach, describe, expect, it } from 'vitest';
import { applyFields } from '../src/content/apply-fields';
import { scanForm } from '../src/content/scanner/form-scanner';

afterEach(() => { document.body.replaceChildren(); });

const assignment = (index = 0, value: string | boolean) => {
  const scanned = scanForm();
  return {
    scanned,
    field: { targetKey: scanned.controls[index].field.key, label: '字段', value },
  };
};

describe('control compatibility', () => {
  it('copies and fills a native select hidden behind a select2-style widget', async () => {
    document.body.innerHTML = `<form>
      <label for="city">城市</label>
      <select id="city" name="city" aria-hidden="true" style="display:none">
        <option value="bj">北京</option>
        <option value="sh">上海</option>
      </select>
      <span class="select2 select2-container" role="combobox" aria-expanded="false">
        <span class="select2-selection__rendered">北京</span>
      </span>
    </form>`;

    const scanned = scanForm();
    expect(scanned.result.fields.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'city', value: 'bj' },
    ]);

    const report = await applyFields([
      { targetKey: scanned.controls[0].field.key, label: '城市', value: 'sh' },
    ]);
    expect(report).toMatchObject({ success: 1, failed: 0, skipped: 0 });
    expect(document.querySelector<HTMLSelectElement>('select')!.value).toBe('sh');
  });

  it('fills a display-none checkbox that is replaced by its visible label', async () => {
    document.body.innerHTML =
      '<form><label>启用<input type="checkbox" name="enabled" style="display:none"></label></form>';

    const { scanned, field } = assignment(0, true);
    expect(scanned.result.fields[0].value).toBe(false);

    const report = await applyFields([field]);
    expect(report).toMatchObject({ success: 1, failed: 0 });
    expect(document.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  });

  it('copies and fills radios that omit the value attribute', async () => {
    document.body.innerHTML =
      '<form><label>甲<input type="radio" name="kind"></label><label>乙<input type="radio" name="kind" checked></label></form>';

    const { scanned, field } = assignment(0, '甲');
    expect(scanned.result.fields).toHaveLength(1);
    expect(scanned.result.fields[0].value).toBe('乙');

    const report = await applyFields([field]);
    expect(report).toMatchObject({ success: 1, failed: 0 });
    expect(document.querySelectorAll<HTMLInputElement>('input')[0].checked).toBe(true);
  });

  it('reads a custom dropdown value that only exists as visible text', () => {
    document.body.innerHTML = `<form>
      <div class="ehi-select" role="combobox" aria-expanded="false">
        <input name="kind" value="">
        <span class="ehi-select-value">类型 A</span>
      </div>
    </form>`;

    expect(scanForm().result.fields.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'kind', value: '类型 A' },
    ]);
  });

  it('fills a searchable dropdown whose options render only after typing', async () => {
    document.body.innerHTML = `<form>
      <div class="ehi-select" role="combobox" aria-expanded="false">
        <input name="kind" role="combobox" value="">
      </div>
    </form>`;
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.addEventListener('input', () => {
      document.querySelector('.ehi-select-menu')?.remove();
      const menu = document.createElement('div');
      menu.className = 'ehi-select-menu dropdown';
      menu.setAttribute('role', 'listbox');
      menu.innerHTML = `<div role="option">${input.value}</div>`;
      menu.querySelector('[role="option"]')!.addEventListener('click', () => menu.remove());
      document.body.appendChild(menu);
    });

    const { field } = assignment(0, '类型 C');
    const report = await applyFields([field]);
    expect(report).toMatchObject({ success: 1, failed: 0 });
    expect(input.value).toBe('类型 C');
  });

  it('fills a cascader by clicking each level of the path', async () => {
    document.body.innerHTML = '<form><div class="el-cascader"><input name="region" readonly value=""></div></form>';
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.addEventListener('click', () => {
      if (document.querySelector('.el-cascader__dropdown')) return;
      const popup = document.createElement('div');
      popup.className = 'el-cascader__dropdown';
      const province = document.createElement('div');
      province.className = 'el-cascader-node';
      province.textContent = '浙江';
      province.addEventListener('click', () => {
        province.remove();
        const city = document.createElement('div');
        city.className = 'el-cascader-node';
        city.textContent = '杭州';
        city.addEventListener('click', () => {
          input.value = '浙江 / 杭州';
          popup.remove();
        });
        popup.appendChild(city);
      });
      popup.appendChild(province);
      document.body.appendChild(popup);
    });

    const { scanned, field } = assignment(0, '浙江 / 杭州');
    expect(scanned.result.fields[0].type).toBe('select');

    const report = await applyFields([field]);
    expect(report).toMatchObject({ success: 1, failed: 0 });
    expect(input.value).toBe('浙江 / 杭州');
  });

  it('treats a cascader whose class also contains picker as a select', () => {
    document.body.innerHTML =
      '<form><div class="ant-cascader-picker"><input name="region" readonly value=""></div></form>';

    expect(scanForm().result.fields[0].type).toBe('select');
  });

  it('does not copy a custom dropdown placeholder as its value', () => {
    document.body.innerHTML = `<form>
      <div class="ant-select" role="combobox">
        <input readonly role="combobox" value="">
        <span class="ant-select-selection-placeholder">请选择</span>
      </div>
    </form>`;

    expect(scanForm().result.fields[0].value).toBe('');
  });

  it('fills an option that only renders after scrolling a virtualized list', async () => {
    document.body.innerHTML = `<form>
      <div class="ant-select" role="combobox">
        <input readonly role="combobox" value="">
        <span class="ant-select-selection-item" style="display:none"></span>
      </div>
    </form>`;
    const root = document.querySelector<HTMLElement>('.ant-select')!;
    const input = root.querySelector('input')!;
    const selected = root.querySelector<HTMLElement>('.ant-select-selection-item')!;
    input.addEventListener('click', () => {
      if (document.querySelector('.rc-virtual-list-holder')) return;
      const dropdown = document.createElement('div');
      dropdown.className = 'ant-select-dropdown';
      const holder = document.createElement('div');
      holder.className = 'rc-virtual-list-holder';
      holder.style.cssText = 'height:40px;overflow-y:auto';
      const list = document.createElement('div');
      list.style.cssText = 'height:200px';
      for (let index = 0; index < 3; index += 1) {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = `选项 ${index}`;
        option.style.height = '40px';
        option.addEventListener('click', () => {
          selected.textContent = option.textContent;
          selected.style.display = '';
          dropdown.remove();
        });
        list.appendChild(option);
      }
      holder.appendChild(list);
      holder.addEventListener('scroll', () => {
        if (holder.scrollTop === 0 || list.querySelector('[data-target]')) return;
        const target = document.createElement('div');
        target.setAttribute('role', 'option');
        target.dataset.target = 'true';
        target.textContent = '目标选项';
        target.style.height = '40px';
        target.addEventListener('click', () => {
          selected.textContent = '目标选项';
          selected.style.display = '';
          dropdown.remove();
        });
        list.appendChild(target);
      });
      dropdown.appendChild(holder);
      document.body.appendChild(dropdown);
    });

    const { scanned, field } = assignment(0, '目标选项');
    expect(scanned.result.fields[0].type).toBe('select');

    const report = await applyFields([field]);
    expect(report).toMatchObject({ success: 1, failed: 0 });
    expect(selected.textContent).toBe('目标选项');
  });

  it('fills a switch that exposes its state through data-state only', async () => {
    document.body.innerHTML = '<form><div role="switch" data-state="unchecked"></div></form>';
    const control = document.querySelector<HTMLElement>('[role="switch"]')!;
    control.addEventListener('click', () => {
      control.setAttribute('data-state', control.getAttribute('data-state') === 'checked' ? 'unchecked' : 'checked');
    });

    const { scanned, field } = assignment(0, true);
    expect(scanned.result.fields[0].value).toBe(false);

    const report = await applyFields([field]);
    expect(report).toMatchObject({ success: 1, failed: 0 });
    expect(control.getAttribute('data-state')).toBe('checked');
  });
});
