import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

export type LatexMathMode = 'inline' | 'block'

export type LatexFormatOptions = {
  mode?: LatexMathMode
  /**
   * 当上游（MarkdownDisplay）已经识别出 \\begin{...} 环境时，这里能拿到 envName。
   * 主要用于 cases 这类：上游可能会把 begin/end 行剥掉，导致这里无法再从 raw 里判断环境类型。
   */
  envName?: string
}

const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  omicron: 'ο',
  pi: 'π',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',

  Alpha: 'Α',
  Beta: 'Β',
  Gamma: 'Γ',
  Delta: 'Δ',
  Epsilon: 'Ε',
  Zeta: 'Ζ',
  Eta: 'Η',
  Theta: 'Θ',
  Iota: 'Ι',
  Kappa: 'Κ',
  Lambda: 'Λ',
  Mu: 'Μ',
  Nu: 'Ν',
  Xi: 'Ξ',
  Omicron: 'Ο',
  Pi: 'Π',
  Rho: 'Ρ',
  Sigma: 'Σ',
  Tau: 'Τ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Chi: 'Χ',
  Psi: 'Ψ',
  Omega: 'Ω',
}

const COMMAND_REPLACEMENTS: Array<[RegExp, string]> = [
  // 常见函数
  [/\\ln\b/g, 'ln'],
  [/\\log\b/g, 'log'],
  [/\\exp\b/g, 'exp'],
  [/\\sin\b/g, 'sin'],
  [/\\cos\b/g, 'cos'],
  [/\\tan\b/g, 'tan'],
  [/\\cot\b/g, 'cot'],
  [/\\sec\b/g, 'sec'],
  [/\\csc\b/g, 'csc'],
  [/\\det\b/g, 'det'],
  [/\\dim\b/g, 'dim'],
  [/\\ker\b/g, 'ker'],
  [/\\max\b/g, 'max'],
  [/\\min\b/g, 'min'],
  [/\\lim\b/g, 'lim'],
  [/\\sup\b/g, 'sup'],
  [/\\inf\b/g, 'inf'],

  [/\\cdot/g, '·'],
  [/\\times/g, '×'],
  [/\\pm/g, '±'],
  [/\\mp/g, '∓'],
  [/\\leq/g, '≤'],
  [/\\le\b/g, '≤'],
  [/\\geq/g, '≥'],
  [/\\ge\b/g, '≥'],
  [/\\neq/g, '≠'],
  [/\\ne\b/g, '≠'],
  [/\\approx/g, '≈'],
  [/\\sim/g, '∼'],
  [/\\equiv/g, '≡'],
  [/\\cong/g, '≅'],
  [/\\propto/g, '∝'],
  [/\\to\b/g, '→'],
  [/\\rightarrow/g, '→'],
  [/\\leftarrow/g, '←'],
  [/\\Rightarrow/g, '⇒'],
  [/\\Leftarrow/g, '⇐'],
  [/\\leftrightarrow/g, '↔'],
  [/\\Leftrightarrow/g, '⇔'],
  [/\\iff/g, '⇔'],
  [/\\mapsto/g, '↦'],
  [/\\infty/g, '∞'],
  [/\\partial/g, '∂'],
  [/\\nabla/g, '∇'],
  [/\\forall/g, '∀'],
  [/\\exists/g, '∃'],
  [/\\nexists/g, '∄'],
  [/\\in\b/g, '∈'],
  [/\\notin/g, '∉'],
  [/\\ni\b/g, '∋'],
  [/\\subseteq/g, '⊆'],
  [/\\subset/g, '⊂'],
  [/\\supseteq/g, '⊇'],
  [/\\supset/g, '⊃'],
  [/\\cup/g, '∪'],
  [/\\cap/g, '∩'],
  [/\\emptyset/g, '∅'],
  [/\\varnothing/g, '∅'],
  [/\\setminus/g, '∖'],
  [/\\sum/g, '∑'],
  [/\\prod/g, '∏'],
  [/\\coprod/g, '∐'],
  [/\\oint/g, '∮'],
  [/\\iint/g, '∬'],
  [/\\iiint/g, '∭'],
  [/\\int/g, '∫'],
  [/\\cdots/g, '⋯'],
  [/\\ldots/g, '…'],
  [/\\vdots/g, '⋮'],
  [/\\ddots/g, '⋱'],
  [/\\dots/g, '…'],
  [/\\circ/g, '∘'],
  [/\\bullet/g, '•'],
  [/\\star/g, '⋆'],
  [/\\ast/g, '∗'],
  [/\\oplus/g, '⊕'],
  [/\\otimes/g, '⊗'],
  [/\\odot/g, '⊙'],
  [/\\neg/g, '¬'],
  [/\\lnot/g, '¬'],
  [/\\land/g, '∧'],
  [/\\lor/g, '∨'],
  [/\\wedge/g, '∧'],
  [/\\vee/g, '∨'],
  [/\\perp/g, '⊥'],
  [/\\parallel/g, '∥'],
  [/\\angle/g, '∠'],
  [/\\triangle/g, '△'],
  [/\\square/g, '□'],
  [/\\diamond/g, '◇'],
  [/\\prime/g, '′'],
  [/\\hbar/g, 'ℏ'],
  [/\\ell/g, 'ℓ'],
  [/\\Re\b/g, 'ℜ'],
  [/\\Im\b/g, 'ℑ'],
  [/\\aleph/g, 'ℵ'],
]

const MATHBB: Record<string, string> = {
  R: 'ℝ',
  N: 'ℕ',
  Z: 'ℤ',
  Q: 'ℚ',
  C: 'ℂ',
  P: 'ℙ',
  H: 'ℍ',
  A: '𝔸',
  B: '𝔹',
  D: '𝔻',
  E: '𝔼',
  F: '𝔽',
  G: '𝔾',
  I: '𝕀',
  J: '𝕁',
  K: '𝕂',
  L: '𝕃',
  M: '𝕄',
  O: '𝕆',
  S: '𝕊',
  T: '𝕋',
  U: '𝕌',
  V: '𝕍',
  W: '𝕎',
  X: '𝕏',
  Y: '𝕐',
}

// 花体字母 \mathcal{X}
const MATHCAL: Record<string, string> = {
  A: '𝒜', B: 'ℬ', C: '𝒞', D: '𝒟', E: 'ℰ', F: 'ℱ', G: '𝒢', H: 'ℋ',
  I: 'ℐ', J: '𝒥', K: '𝒦', L: 'ℒ', M: 'ℳ', N: '𝒩', O: '𝒪', P: '𝒫',
  Q: '𝒬', R: 'ℛ', S: '𝒮', T: '𝒯', U: '𝒰', V: '𝒱', W: '𝒲', X: '𝒳',
  Y: '𝒴', Z: '𝒵',
}

// 哥特体/德文尖角体 \mathfrak{X}
const MATHFRAK: Record<string, string> = {
  A: '𝔄', B: '𝔅', C: 'ℭ', D: '𝔇', E: '𝔈', F: '𝔉', G: '𝔊', H: 'ℌ',
  I: 'ℑ', J: '𝔍', K: '𝔎', L: '𝔏', M: '𝔐', N: '𝔑', O: '𝔒', P: '𝔓',
  Q: '𝔔', R: 'ℜ', S: '𝔖', T: '𝔗', U: '𝔘', V: '𝔙', W: '𝔚', X: '𝔛',
  Y: '𝔜', Z: 'ℨ',
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ',
  'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ',
  'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ',
  'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
  'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
  'A': 'ᴬ', 'B': 'ᴮ', 'D': 'ᴰ', 'E': 'ᴱ', 'G': 'ᴳ',
  'H': 'ᴴ', 'I': 'ᴵ', 'J': 'ᴶ', 'K': 'ᴷ', 'L': 'ᴸ',
  'M': 'ᴹ', 'N': 'ᴺ', 'O': 'ᴼ', 'P': 'ᴾ', 'R': 'ᴿ',
  'T': 'ᵀ', 'U': 'ᵁ', 'V': 'ⱽ', 'W': 'ᵂ',
  'α': 'ᵅ', 'β': 'ᵝ', 'γ': 'ᵞ', 'δ': 'ᵟ', 'ε': 'ᵋ',
  'θ': 'ᶿ', 'ι': 'ᶥ', 'φ': 'ᵠ', 'χ': 'ᵡ',
  "'": '′', "''": '″', '*': '⁎',
}

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ',
  'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
  'v': 'ᵥ', 'x': 'ₓ',
  'β': 'ᵦ', 'γ': 'ᵧ', 'ρ': 'ᵨ', 'φ': 'ᵩ', 'χ': 'ᵪ',
}

function toSuperSub(
  raw: string,
  map: Record<string, string>,
): string | null {
  if (!raw) return null
  let out = ''
  for (const ch of raw) {
    const mapped = map[ch]
    if (!mapped) return null
    out += mapped
  }
  return out
}

function stripEnclosingBraces(s: string): string {
  const trimmed = s.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function visualWidth(textWithAnsi: string): number {
  return stringWidth(stripAnsi(textWithAnsi))
}

function padRight(text: string, targetWidth: number): string {
  const w = visualWidth(text)
  if (w >= targetWidth) return text
  return text + ' '.repeat(targetWidth - w)
}

function padCenter(text: string, targetWidth: number): string {
  const w = visualWidth(text)
  if (w >= targetWidth) return text
  const total = targetWidth - w
  const left = Math.floor(total / 2)
  const right = total - left
  return ' '.repeat(left) + text + ' '.repeat(right)
}

function splitOuterWhitespace(input: string): { leading: string; core: string; trailing: string } {
  const leading = input.match(/^\s+/)?.[0] ?? ''
  const trailing = input.match(/\s+$/)?.[0] ?? ''
  const core = input.slice(leading.length, input.length - trailing.length)
  return { leading, core, trailing }
}

function skipSpaces(input: string, start: number): number {
  let i = start
  while (i < input.length && /\s/.test(input[i] ?? '')) i++
  return i
}

function consumeBraceGroup(
  input: string,
  start: number,
): { content: string; endIndex: number } | null {
  if (input[start] !== '{') return null
  let depth = 0
  let i = start
  const contentStart = start + 1
  while (i < input.length) {
    const ch = input[i] ?? ''
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return { content: input.slice(contentStart, i), endIndex: i + 1 }
      }
    }
    i++
  }
  return null
}

function replaceSimpleCommands(input: string): string {
  let out = input

  // \mathbb{R} -> ℝ
  out = out.replace(/\\mathbb\{([A-Za-z])\}/g, (_, letter: string) => {
    return MATHBB[letter] ?? letter
  })

  // \mathcal{L} -> ℒ
  out = out.replace(/\\mathcal\{([A-Za-z])\}/g, (_, letter: string) => {
    return MATHCAL[letter] ?? letter
  })

  // \mathfrak{R} -> ℜ
  out = out.replace(/\\mathfrak\{([A-Za-z])\}/g, (_, letter: string) => {
    return MATHFRAK[letter] ?? letter
  })

  // \vec{x} -> x⃗
  out = out.replace(/\\vec\{([^}]+)\}/g, (_, content: string) => {
    return content + '⃗'
  })

  // \hat{x} -> x̂
  out = out.replace(/\\hat\{([^}]+)\}/g, (_, content: string) => {
    return content + '̂'
  })

  // \bar{x} -> x̄
  out = out.replace(/\\bar\{([^}]+)\}/g, (_, content: string) => {
    return content + '̄'
  })

  // \tilde{x} -> x̃
  out = out.replace(/\\tilde\{([^}]+)\}/g, (_, content: string) => {
    return content + '̃'
  })

  // \dot{x} -> ẋ (使用组合字符)
  out = out.replace(/\\dot\{([^}]+)\}/g, (_, content: string) => {
    return content + '̇'
  })

  // \ddot{x} -> ẍ
  out = out.replace(/\\ddot\{([^}]+)\}/g, (_, content: string) => {
    return content + '̈'
  })

  // \overline{x} -> x̅
  out = out.replace(/\\overline\{([^}]+)\}/g, (_, content: string) => {
    return content + '̅'
  })

  // \underline{x} -> x̲
  out = out.replace(/\\underline\{([^}]+)\}/g, (_, content: string) => {
    return content + '̲'
  })

  // Greek letters
  out = out.replace(/\\([A-Za-z]+)(?![A-Za-z{])/g, (match, name: string) => {
    return GREEK[name] ?? match
  })

  for (const [re, replacement] of COMMAND_REPLACEMENTS) {
    out = out.replace(re, replacement)
  }

  return out
}

function replaceFracAndSqrt(input: string, mode: LatexMathMode): string {
  let out = ''
  let i = 0

  while (i < input.length) {
    if (input.startsWith('\\frac', i)) {
      const afterCmd = skipSpaces(input, i + '\\frac'.length)
      const numGroup = consumeBraceGroup(input, afterCmd)
      if (!numGroup) {
        out += '\\frac'
        i += '\\frac'.length
        continue
      }
      const afterNum = skipSpaces(input, numGroup.endIndex)
      const denGroup = consumeBraceGroup(input, afterNum)
      if (!denGroup) {
        out += '\\frac{' + numGroup.content + '}'
        i = numGroup.endIndex
        continue
      }

      const num = formatLatexMath(numGroup.content, { mode: 'inline' })
      const den = formatLatexMath(denGroup.content, { mode: 'inline' })

      // 先统一走“行内分数”，块级的“堆叠分数”在 formatLatexMath(mode=block) 里做更合适
      out += `(${stripEnclosingBraces(num)})/(${stripEnclosingBraces(den)})`
      i = denGroup.endIndex
      continue
    }

    if (input.startsWith('\\sqrt', i)) {
      let idx = skipSpaces(input, i + '\\sqrt'.length)

      // \sqrt[n]{...} 这种先粗略跳过 [n]
      if (input[idx] === '[') {
        const endBracket = input.indexOf(']', idx + 1)
        if (endBracket !== -1) idx = skipSpaces(input, endBracket + 1)
      }

      const group = consumeBraceGroup(input, idx)
      if (!group) {
        out += '\\sqrt'
        i += '\\sqrt'.length
        continue
      }

      const inner = formatLatexMath(group.content, { mode: 'inline' })
      out += `√(${stripEnclosingBraces(inner)})`
      i = group.endIndex
      continue
    }

    out += input[i] ?? ''
    i++
  }

  return out
}

function replaceSuperSubScripts(input: string): string {
  let out = input

  // ^{...} - 大括号包裹的上标
  out = out.replace(/\^\{([^{}]+)\}/g, (_, exp: string) => {
    const mapped = toSuperSub(exp, SUPERSCRIPT)
    return mapped ?? `^(${exp})`
  })
  // _{...} - 大括号包裹的下标
  out = out.replace(/_\{([^{}]+)\}/g, (_, sub: string) => {
    const mapped = toSuperSub(sub, SUBSCRIPT)
    return mapped ?? `_(${sub})`
  })
  // ^x - 单字符上标（扩展支持更多字符）
  out = out.replace(/\^([0-9a-zA-Z+\-=()αβγδεθιφχ*'])/g, (_, exp: string) => {
    const mapped = SUPERSCRIPT[exp]
    return mapped ?? `^${exp}`
  })
  // _x - 单字符下标（扩展支持更多字符）
  out = out.replace(/_([0-9a-ehijklmnoprstuvxβγρφχ+\-=()])/g, (_, sub: string) => {
    const mapped = SUBSCRIPT[sub]
    return mapped ?? `_${sub}`
  })

  return out
}

function cleanup(input: string): string {
  return input
    .replace(/\\left/g, '')
    .replace(/\\right/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\;/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\quad/g, '  ')
    .replace(/\\qquad/g, '    ')
    .replace(/\\text\{([^}]*)\}/g, (_, t: string) => t)
    .replace(/\\mathrm\{([^}]*)\}/g, (_, t: string) => t)
    .replace(/\\mathbf\{([^}]*)\}/g, (_, t: string) => t)
    .replace(/\\mathit\{([^}]*)\}/g, (_, t: string) => t)
    .replace(/\\textbf\{([^}]*)\}/g, (_, t: string) => `**${t}**`)
    .replace(/\\textit\{([^}]*)\}/g, (_, t: string) => `_${t}_`)
    .replace(/\\emph\{([^}]*)\}/g, (_, t: string) => `_${t}_`)
    .replace(/\\texttt\{([^}]*)\}/g, (_, t: string) => `\`${t}\``)
    .replace(/\\color\{[^}]*\}\{([^}]*)\}/g, (_, t: string) => t)
    .replace(/\\color\{[^}]*\}/g, '')
    .replace(/\\hline/g, '')
    .replace(/\\centering/g, '')
    .replace(/\\caption\{([^}]*)\}/g, (_, t: string) => `[${t}]`)
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\nonumber/g, '')
    .replace(/\\displaystyle/g, '')
    .replace(/\\scriptstyle/g, '')
    .replace(/\\textstyle/g, '')
    .replace(/\\\\/g, '\n')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim()
}

function formatInlineCore(raw: string): string {
  let out = cleanup(raw)
  out = replaceFracAndSqrt(out, 'inline')
  out = replaceSimpleCommands(out)
  out = replaceSuperSubScripts(out)
  // 行内：把换行压成空格，避免把 UI 顶乱
  out = out.replace(/\s*\n+\s*/g, ' ')
  return out.trim()
}

function extractEnvironment(input: string, envName: string): { before: string; content: string; after: string } | null {
  const begin = `\\begin{${envName}}`
  const end = `\\end{${envName}}`
  const beginIndex = input.indexOf(begin)
  if (beginIndex === -1) return null
  const endIndex = input.indexOf(end, beginIndex + begin.length)
  if (endIndex === -1) return null

  return {
    before: input.slice(0, beginIndex),
    content: input.slice(beginIndex + begin.length, endIndex),
    after: input.slice(endIndex + end.length),
  }
}

function formatCasesContent(contentRaw: string, prefixRaw = '', suffixRaw = ''): string {
  const prefixParts = splitOuterWhitespace(prefixRaw)
  const suffixParts = splitOuterWhitespace(suffixRaw)

  const prefix = prefixParts.leading + formatInlineCore(prefixParts.core) + prefixParts.trailing
  const suffix = suffixParts.leading + formatInlineCore(suffixParts.core) + suffixParts.trailing

  const lines = contentRaw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    const full = (prefix + suffix).trim()
    return full ? full : ''
  }

  const hasAmp = lines.some(l => l.includes('&'))
  const hasEq = !hasAmp && lines.some(l => l.includes('='))
  const splitMarker: '&' | '=' | null = hasAmp ? '&' : hasEq ? '=' : null

  const rows = lines.map(line => {
    if (!splitMarker) return { left: line, right: '' }
    const idx = line.indexOf(splitMarker)
    if (idx === -1) return { left: line, right: '' }

    if (splitMarker === '&') {
      return { left: line.slice(0, idx), right: line.slice(idx + 1) }
    }

    // '='：右侧保留 '='，这样更像“对齐等号”
    return { left: line.slice(0, idx), right: line.slice(idx) }
  })

  const formatted = rows.map(r => {
    const left = formatInlineCore(r.left)
    const right = formatInlineCore(r.right)
    return { left, right }
  })

  const maxLeft = Math.max(0, ...formatted.map(r => visualWidth(r.left)))

  const bracePrefix = (idx: number, total: number): string => {
    if (total === 1) return '{ '
    if (total === 2) return idx === 0 ? '⎧ ' : '⎩ '
    if (idx === 0) return '⎧ '
    if (idx === total - 1) return '⎩ '
    return '⎨ '
  }

  const prefixWidth = visualWidth(prefix)
  const outLines = formatted.map((r, idx) => {
    const leftPadded = padRight(r.left, maxLeft)
    const body = r.right ? `${leftPadded} ${r.right}` : leftPadded
    const pfx = idx === 0 ? prefix : ' '.repeat(prefixWidth)
    return `${pfx}${bracePrefix(idx, formatted.length)}${body}`.trimEnd()
  })

  // suffix 放在最后一行尾巴上，比较自然（比如 "\\end{cases}," 那个逗号）
  if (suffix.trim()) {
    const last = outLines[outLines.length - 1] ?? ''
    outLines[outLines.length - 1] = (last + suffix).trimEnd()
  }

  return outLines.join('\n')
}

function formatDisplayFractionMaybe(raw: string): string | null {
  const idx = raw.indexOf('\\frac')
  if (idx === -1) return null

  const afterCmd = skipSpaces(raw, idx + '\\frac'.length)
  const numGroup = consumeBraceGroup(raw, afterCmd)
  if (!numGroup) return null
  const afterNum = skipSpaces(raw, numGroup.endIndex)
  const denGroup = consumeBraceGroup(raw, afterNum)
  if (!denGroup) return null

  const prefixRaw = raw.slice(0, idx)
  const suffixRaw = raw.slice(denGroup.endIndex)
  if (prefixRaw.includes('\n') || suffixRaw.includes('\n')) return null

  const prefixParts = splitOuterWhitespace(prefixRaw)
  const suffixParts = splitOuterWhitespace(suffixRaw)
  const prefix = prefixParts.leading + formatInlineCore(prefixParts.core) + prefixParts.trailing
  const suffix = suffixParts.leading + formatInlineCore(suffixParts.core) + suffixParts.trailing

  const num = formatInlineCore(numGroup.content)
  const den = formatInlineCore(denGroup.content)

  const barWidth = Math.max(visualWidth(num), visualWidth(den))
  if (barWidth <= 0) return null

  const numLine = padCenter(num, barWidth)
  const denLine = padCenter(den, barWidth)
  const barLine = '─'.repeat(barWidth)

  const prefixWidth = visualWidth(prefix)
  const suffixWidth = visualWidth(suffix)

  const top = ' '.repeat(prefixWidth) + numLine + ' '.repeat(suffixWidth)
  const mid = `${prefix}${barLine}${suffix}`.trimEnd()
  const bottom = ' '.repeat(prefixWidth) + denLine + ' '.repeat(suffixWidth)

  return [top, mid, bottom].join('\n')
}

// 矩阵类型到括号字符的映射
const MATRIX_BRACKETS: Record<string, { left: string[]; right: string[] }> = {
  matrix: { left: ['', '', ''], right: ['', '', ''] },
  pmatrix: { left: ['⎛', '⎜', '⎝'], right: ['⎞', '⎟', '⎠'] },
  bmatrix: { left: ['⎡', '⎢', '⎣'], right: ['⎤', '⎥', '⎦'] },
  Bmatrix: { left: ['⎧', '⎨', '⎩'], right: ['⎫', '⎬', '⎭'] },
  vmatrix: { left: ['│', '│', '│'], right: ['│', '│', '│'] },
  Vmatrix: { left: ['‖', '‖', '‖'], right: ['‖', '‖', '‖'] },
}

function formatMatrixContent(contentRaw: string, matrixType: string, prefixRaw = '', suffixRaw = ''): string {
  const prefixParts = splitOuterWhitespace(prefixRaw)
  const suffixParts = splitOuterWhitespace(suffixRaw)
  const prefix = prefixParts.leading + formatInlineCore(prefixParts.core) + prefixParts.trailing
  const suffix = suffixParts.leading + formatInlineCore(suffixParts.core) + suffixParts.trailing

  // 解析行（用 \\ 分隔）和列（用 & 分隔）
  const rows = contentRaw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(row => row.split('&').map(cell => formatInlineCore(cell.trim())))

  if (rows.length === 0) {
    return (prefix + suffix).trim()
  }

  // 计算每列的最大宽度
  const colCount = Math.max(...rows.map(r => r.length))
  const colWidths: number[] = new Array(colCount).fill(0)
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, visualWidth(row[i] || ''))
    }
  }

  // 格式化每行
  const formattedRows = rows.map(row => {
    const cells = row.map((cell, i) => padCenter(cell, colWidths[i] || 0))
    return cells.join('  ')
  })

  // 获取括号字符
  const brackets = MATRIX_BRACKETS[matrixType] || MATRIX_BRACKETS.matrix
  const rowCount = formattedRows.length
  const prefixWidth = visualWidth(prefix)

  const getBracket = (brackets: string[], idx: number, total: number): string => {
    if (brackets[0] === '') return ''
    if (total === 1) return brackets[1] || brackets[0]
    if (total === 2) return idx === 0 ? brackets[0] : brackets[2]
    if (idx === 0) return brackets[0]
    if (idx === total - 1) return brackets[2]
    return brackets[1]
  }

  const outLines = formattedRows.map((row, idx) => {
    const leftBracket = getBracket(brackets.left, idx, rowCount)
    const rightBracket = getBracket(brackets.right, idx, rowCount)
    const pfx = idx === 0 ? prefix : ' '.repeat(prefixWidth)
    return `${pfx}${leftBracket} ${row} ${rightBracket}`.trimEnd()
  })

  if (suffix.trim()) {
    const last = outLines[outLines.length - 1] ?? ''
    outLines[outLines.length - 1] = (last + suffix).trimEnd()
  }

  return outLines.join('\n')
}

// 支持的矩阵环境名称
const MATRIX_ENVS = ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']

// 支持的对齐环境名称
const ALIGN_ENVS = ['aligned', 'align', 'align*', 'gather', 'gather*', 'equation', 'equation*', 'eqnarray', 'eqnarray*', 'split']

// 格式化对齐环境（aligned, align 等）
function formatAlignedContent(contentRaw: string): string {
  // 按行分割
  const lines = contentRaw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  if (lines.length === 0) return ''

  // 检查是否使用 & 作为对齐点
  const hasAmp = lines.some(l => l.includes('&'))

  if (!hasAmp) {
    // 没有对齐点，直接格式化每行
    return lines.map(line => formatInlineCore(line)).join('\n')
  }

  // 解析每行，按 & 分割
  const rows = lines.map(line => {
    const parts = line.split('&').map(p => formatInlineCore(p.trim()))
    return parts
  })

  // 计算每列的最大宽度
  const colCount = Math.max(...rows.map(r => r.length))
  const colWidths: number[] = new Array(colCount).fill(0)
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, visualWidth(row[i] || ''))
    }
  }

  // 格式化每行，右对齐第一列（通常是等号左边），左对齐其余列
  const formattedLines = rows.map(row => {
    const parts = row.map((cell, i) => {
      const width = colWidths[i] || 0
      if (i === 0) {
        // 第一列右对齐
        return cell.padStart(width)
      } else {
        // 其余列左对齐
        return padRight(cell, width)
      }
    })
    return parts.join(' ')
  })

  return formattedLines.join('\n')
}

// LaTeX tabular 表格环境渲染
function formatTabularContent(contentRaw: string): string {
  // 按行分割，处理 \\ 换行
  const lines = contentRaw
    .replace(/\\hline/g, '') // 移除 \hline，用边框字符代替
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  if (lines.length === 0) return ''

  // 解析每行的单元格（用 & 分隔）
  const rows = lines.map(row =>
    row.split('&').map(cell => formatInlineCore(cell.trim()))
  )

  // 计算列数和每列宽度
  const colCount = Math.max(...rows.map(r => r.length))
  const colWidths: number[] = new Array(colCount).fill(0)
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, visualWidth(row[i] || ''))
    }
  }

  // 构建表格边框
  const topBorder = '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐'
  const midBorder = '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤'
  const bottomBorder = '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘'

  // 格式化每行
  const formatRow = (row: string[]): string => {
    const cells = colWidths.map((w, i) => {
      const cell = row[i] || ''
      return ' ' + padRight(cell, w) + ' '
    })
    return '│' + cells.join('│') + '│'
  }

  const outLines: string[] = [topBorder]

  // 假设第一行是表头
  if (rows.length > 0) {
    outLines.push(formatRow(rows[0]!))
    if (rows.length > 1) {
      outLines.push(midBorder)
      for (let i = 1; i < rows.length; i++) {
        outLines.push(formatRow(rows[i]!))
      }
    }
  }

  outLines.push(bottomBorder)
  return outLines.join('\n')
}

// 处理 table 浮动体环境，提取其中的 tabular
function formatTableEnvironment(contentRaw: string): string {
  // 尝试提取 tabular 环境
  const tabularMatch = contentRaw.match(/\\begin\{tabular\}(?:\{[^}]*\})?([\s\S]*?)\\end\{tabular\}/)
  if (tabularMatch) {
    const tableContent = formatTabularContent(tabularMatch[1] || '')
    // 提取 caption
    const captionMatch = contentRaw.match(/\\caption\{([^}]*)\}/)
    const caption = captionMatch ? `[${captionMatch[1]}]` : ''
    return caption ? `${tableContent}\n${caption}` : tableContent
  }
  return formatInlineCore(contentRaw)
}

export function formatLatexMath(raw: string, options: LatexFormatOptions = {}): string {
  const mode: LatexMathMode = options.mode ?? 'inline'

  // 行内：保持稳定、不要产生多行
  if (mode === 'inline') return formatInlineCore(raw)

  const cleaned = cleanup(raw)
  const env = (options.envName ?? '').replace(/\*$/, '')

  // cases：用"左大括号 + 每行"来表现，比原来一坨更像样
  if (env === 'cases') return formatCasesContent(cleaned)

  const extracted = extractEnvironment(cleaned, 'cases')
  if (extracted) {
    return formatCasesContent(extracted.content, extracted.before, extracted.after)
  }

  // 矩阵环境处理
  if (MATRIX_ENVS.includes(env)) {
    return formatMatrixContent(cleaned, env)
  }

  // 从内容中提取矩阵环境
  for (const matrixEnv of MATRIX_ENVS) {
    const matrixExtracted = extractEnvironment(cleaned, matrixEnv)
    if (matrixExtracted) {
      return formatMatrixContent(matrixExtracted.content, matrixEnv, matrixExtracted.before, matrixExtracted.after)
    }
  }

  // 对齐环境处理（aligned, align, gather 等）
  if (ALIGN_ENVS.includes(env) || ALIGN_ENVS.includes(env + '*')) {
    return formatAlignedContent(cleaned)
  }

  // 从内容中提取对齐环境
  for (const alignEnv of ALIGN_ENVS) {
    const alignExtracted = extractEnvironment(cleaned, alignEnv)
    if (alignExtracted) {
      const before = alignExtracted.before ? formatInlineCore(alignExtracted.before) + '\n' : ''
      const after = alignExtracted.after ? '\n' + formatInlineCore(alignExtracted.after) : ''
      return before + formatAlignedContent(alignExtracted.content) + after
    }
  }

  // table 浮动体环境处理
  if (env === 'table') {
    return formatTableEnvironment(cleaned)
  }

  const tableExtracted = extractEnvironment(cleaned, 'table')
  if (tableExtracted) {
    return formatTableEnvironment(tableExtracted.content)
  }

  // tabular 表格环境处理
  if (env === 'tabular') {
    return formatTabularContent(cleaned)
  }

  const tabularExtracted = extractEnvironment(cleaned, 'tabular')
  if (tabularExtracted) {
    return formatTabularContent(tabularExtracted.content)
  }

  // 尝试把最外层的 \\frac 做成"上下堆叠分数"（只对单行表达式做，避免把 UI 撕裂）
  const displayFrac = formatDisplayFractionMaybe(cleaned)
  if (displayFrac) return displayFrac

  // 默认：块级允许换行（cleanup 已经把 \\\\ 变成了 \\n）
  let out = cleaned
  out = replaceFracAndSqrt(out, 'block')
  out = replaceSimpleCommands(out)
  out = replaceSuperSubScripts(out)
  return out.trim()
}

export function visibleWidth(textWithAnsi: string): number {
  return visualWidth(textWithAnsi)
}
