import { afterEach, describe, expect, it } from 'vitest'
import { language, setLanguage, t, tt } from '..'

afterEach(() => {
  setLanguage('zh')
})

describe('i18n', () => {
  it('cooks escapes and keeps Chinese in the reference locale', () => {
    setLanguage('zh')
    expect(t('主题')).toBe('主题')
    expect(tt`第一行\n${'第二行'}`).toBe('第一行\n第二行')
  })

  it('translates static and parameterized strings in English', () => {
    setLanguage('en')
    expect(language.locale).toBe('en')
    expect(t('主题')).toBe('Theme')
    expect(t('当前系统语言解析为：{lang}', { lang: 'English' })).toBe(
      'System language resolves to: English',
    )
  })

  it('translates tagged dynamic templates', () => {
    setLanguage('en')
    expect(tt`已断开「${'local'}」`).toBe('Disconnected “local”')
  })
})
