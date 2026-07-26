/**
 * Query expansion for the local tool catalog.
 *
 * Every tool name, title, and description in the catalog is English, but the
 * Agent talks to the user in Chinese and searches in Chinese. Substring
 * matching can never bridge that on its own: `时间轴` shares no character with
 * `timeline`, so a Chinese query scored 0 against the whole catalog no matter
 * how it was worded. Tokenizing differently does not help either, because the
 * gap is vocabulary, not word boundaries.
 *
 * So the query is expanded through a domain lexicon before scoring. The lexicon
 * is matched by substring rather than by token, which is what makes it work for
 * Chinese: `将媒体库素材添加到时间轴` has no spaces to split on, but it does
 * contain `媒体库`, `添加`, and `时间轴`.
 */

/**
 * Chinese editing vocabulary mapped to the English words the catalog actually
 * uses. Keys are matched as substrings of the raw query, so entries need no
 * word boundaries and may overlap — `时间轴` and `时间` can both fire, which is
 * fine because expansion adds terms rather than choosing between them.
 */
const QUERY_LEXICON: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Timeline and structure
  ['时间轴', ['timeline']],
  ['时间线', ['timeline']],
  ['轨道', ['track']],
  ['序列', ['sequence']],
  ['合成', ['composition']],
  ['片段', ['clip', 'item']],
  ['剪辑', ['clip']],
  ['间隙', ['gap']],
  ['空隙', ['gap']],
  ['标记', ['marker']],
  ['关键帧', ['keyframe']],
  ['播放头', ['playhead']],
  ['项目', ['project']],
  ['工程', ['project']],

  // Media
  ['媒体库', ['media', 'library']],
  ['媒体', ['media']],
  ['素材', ['media', 'clip']],
  ['视频', ['video']],
  ['音频', ['audio']],
  ['图片', ['image']],
  ['字幕', ['subtitle', 'caption']],
  ['转录', ['transcribe', 'transcript']],
  ['语音识别', ['transcribe']],
  ['代理', ['proxy']],
  ['缩略图', ['thumbnail']],
  ['冻结帧', ['freeze', 'frame']],
  ['帧', ['frame']],

  // Actions
  ['导入', ['import']],
  ['导出', ['export']],
  ['添加', ['add', 'place', 'insert', 'create']],
  ['加入', ['add', 'place', 'insert']],
  ['放入', ['place', 'insert', 'add']],
  ['放到', ['place', 'insert', 'add']],
  ['放在', ['place', 'insert']],
  ['插入', ['insert', 'place']],
  ['置入', ['place', 'insert']],
  ['拖入', ['place', 'add']],
  ['上轨', ['place', 'track']],
  ['删除', ['delete', 'remove']],
  ['移除', ['remove', 'delete']],
  ['移动', ['move']],
  ['复制', ['duplicate', 'copy']],
  ['分割', ['split']],
  ['切分', ['split']],
  ['裁剪', ['trim']],
  ['保存', ['save']],
  ['撤销', ['undo']],
  ['重做', ['redo']],
  ['创建', ['create']],
  ['新建', ['create']],
  ['更新', ['update']],
  ['修改', ['update']],
  ['重命名', ['rename']],
  ['关闭', ['close']],
  ['切换', ['switch']],
  ['查找', ['find', 'search']],
  ['搜索', ['search', 'find']],
  ['读取', ['read']],
  ['查看', ['read', 'describe']],
  ['扫描', ['scan']],
  ['检查', ['inspect', 'check', 'scan']],
  ['修复', ['relink', 'repair']],
  ['重连', ['relink']],
  ['聚焦', ['focus']],
  ['选中', ['focus', 'select']],
  ['静音', ['mute']],
  ['锁定', ['lock']],
  ['生成', ['generate']],
  ['取消', ['cancel']],

  // Placement qualifiers the user reaches for
  ['布局', ['layout']],
  ['铺满', ['cover']],
  ['适应', ['contain']],
  ['画中画', ['picture']],
  ['默认', ['default']],

  // Sources
  ['本地', ['local']],
  ['文件夹', ['folder', 'directory']],
  ['目录', ['directory', 'folder']],
  ['文件', ['file']],
  ['路径', ['path']],
  ['链接', ['url', 'link']],
  ['网址', ['url']],

  // Health
  ['健康', ['health']],
  ['完整性', ['integrity']],
  ['缺失', ['missing']],
  ['丢失', ['missing']],
]

/** Splits an English or mixed query the way the catalog text is written. */
function splitTerms(query: string): string[] {
  return query.split(/[\s_./:-]+/u).filter(Boolean)
}

/**
 * Expands a query into the English terms worth scoring. Returns the caller's own
 * terms plus any lexicon hits, deduplicated.
 */
export function expandQueryTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const terms = new Set(splitTerms(normalized))
  for (const [term, expansions] of QUERY_LEXICON) {
    if (!normalized.includes(term)) continue
    for (const expansion of expansions) terms.add(expansion)
  }
  return [...terms]
}

/** True when the query contains Han characters, so it cannot match raw English. */
export function hasChineseCharacters(query: string): boolean {
  return /\p{Script=Han}/u.test(query)
}

export interface ToolSearchCandidate {
  name: string
  title: string
  description: string
  category: string
}

/**
 * Scores one tool against an expanded query. Weighting is unchanged from the
 * original English-only scorer — name beats title beats description — because
 * expansion changes which terms are compared, not how a match is ranked.
 */
export function scoreToolForQuery(tool: ToolSearchCandidate, query: string): number {
  const terms = expandQueryTerms(query)
  if (terms.length === 0) return 0
  const name = tool.name.toLowerCase()
  const title = tool.title.toLowerCase()
  const text = `${name} ${title} ${tool.description.toLowerCase()} ${tool.category.toLowerCase()}`
  return terms.reduce((score, term) => {
    if (name.includes(term)) return score + 4
    if (title.includes(term)) return score + 3
    if (text.includes(term)) return score + 1
    return score
  }, 0)
}
