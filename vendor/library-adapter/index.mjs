export {createMainLibraryAdapter, LibraryError, LIBRARY_TOOL_NAMES} from './core.mjs';
import {checkArgumentKeys, positiveInteger, registerLibraryTools} from './core.mjs';

const text = (description, required = true) => ({ type: 'string', description, ...(required ? {required:true} : {}) });
// Session-rotation archives (base64 parts/manifests) live in the same project; they are
// machine data and crowd real notes out of owner searches.
export const isRotationArchive = r => /(^|\/)xiaoqian-session-archive\//.test(String(r?.file_path || '')) ||
  /^(main\/)?xiaoqian-session-archive\//.test(String(r?.permalink || '')) || /^xqrotation /.test(String(r?.title || ''));
const DESCRIPTIONS = {
  health: '检查长期记忆图书馆是否可用。',
  search: '在主人的长期记忆图书馆里搜索：主人的偏好、经历、人际关系、计划、约定、项目和以前聊过的事。用 1–3 个中文关键词效果最好（不要整句）。返回标题列表，再用 xiaoqian_library_read 读具体内容。',
  read: '读图书馆里的一篇笔记（identifier 用搜索结果里的 permalink 或 file_path）。',
  write: '新建一篇图书馆笔记。只在主人明确要求记下来时使用。',
  edit: '修改已有笔记。只在主人明确要求时使用；需要先 read 拿到 checksum。',
};
const fields = {
  health: {},
  search: { query: text('1–3 个关键词，例如「生日」「Mac Studio」「妈妈」'), page: { type: 'number' }, page_size: { type: 'number' } },
  read: { identifier: text('Relative identifier from main search; no URLs'), include_content: { type: 'boolean' } },
  write: { title: text('New note title'), content: text('Owner-requested note content'), directory: text('Relative folder; . for root') },
  edit: { identifier: text('Exact existing relative identifier'), operation: text('append, prepend, or find_replace'), content: text('New content'), find_text: text('Exact single replacement target', false), expected_checksum: text('Checksum from a fresh read') },
};

async function searchNotes(adapter, chatId, args, context) {
  checkArgumentKeys(args, ['query', 'page', 'page_size']);
  const wanted = positiveInteger(args.page_size, 8, 20);
  const found = await adapter.call(chatId, 'search', {query: args.query, page: args.page, page_size: 20}, context);
  const notes = found.data.results.filter(result => !isRotationArchive(result));
  return {
    ...found,
    data: {
      ...found.data, results: notes.slice(0, wanted), page_size: wanted,
      hiddenArchive: found.data.results.length - notes.length,
    },
  };
}

export function registerOwnerLibraryTools(options) {
  return registerLibraryTools(options, {fields, describe: operation => DESCRIPTIONS[operation], search: searchNotes});
}
