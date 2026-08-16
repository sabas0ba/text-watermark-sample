/*
 * dict.js - 語選択透かしの搬送辞書
 *
 * 各グループは意味を変えずに相互置換可能な 2 つの表層形を持つ。
 * variants[0] を bit 0、variants[1] を bit 1 に対応させる。
 *
 * guards は誤検出 (別語の一部への一致) を抑止する条件。
 *   prevNot   : 直前文字列が該当すると不採用 (末尾アンカで評価)
 *   prevMust  : 直前文字列が該当しないと不採用
 *   nextNot   : 直後文字列が該当すると不採用 (先頭アンカで評価)
 *   sentInit  : 文頭 (行頭・句点直後・開き括弧直後) のみ採用
 *   enWord    : 英単語境界を要求 (lang === 'en' では既定で有効)
 *
 * tier
 *   A : 表記ゆれのみ。意味・語調とも不変。
 *   B : 文脈依存または語調が僅かに変化。
 *   C : 語彙置換。意味は近いが同一ではない。既定では無効。
 */

const KANJI = '\\u3400-\\u9FFF\\u3005\\u3006';
const KANA = '\\u3040-\\u30FF\\u30FC';

const DEFAULT_DICT = [
  // ---- 日本語 tier A: 漢字/かな の表記ゆれ ----
  { id: 'ja_dekiru', lang: 'ja', tier: 'A', variants: ['できる', '出来る'] },
  { id: 'ja_dekinai', lang: 'ja', tier: 'A', variants: ['できない', '出来ない'] },
  { id: 'ja_dekimasu', lang: 'ja', tier: 'A', variants: ['できます', '出来ます'] },
  { id: 'ja_dekimasen', lang: 'ja', tier: 'A', variants: ['できません', '出来ません'] },
  { id: 'ja_kudasai', lang: 'ja', tier: 'A', variants: ['ください', '下さい'], guards: { prevMust: '[てで]$' } },
  { id: 'ja_itadaku', lang: 'ja', tier: 'A', variants: ['いただく', '頂く'], guards: { prevMust: '[てで]$' } },
  { id: 'ja_itadaki', lang: 'ja', tier: 'A', variants: ['いただき', '頂き'], guards: { prevMust: '[てで]$' } },
  { id: 'ja_itadake', lang: 'ja', tier: 'A', variants: ['いただけ', '頂け'], guards: { prevMust: '[てで]$' } },
  { id: 'ja_nado', lang: 'ja', tier: 'A', variants: ['など', '等'], guards: { prevMust: `[${KANA}、。」）]$`, nextNot: `^[${KANJI}]` } },
  { id: 'ja_oyobi', lang: 'ja', tier: 'A', variants: ['および', '及び'] },
  { id: 'ja_matawa', lang: 'ja', tier: 'A', variants: ['または', '又は'] },
  { id: 'ja_moshikuwa', lang: 'ja', tier: 'A', variants: ['もしくは', '若しくは'] },
  { id: 'ja_subete', lang: 'ja', tier: 'A', variants: ['すべて', '全て'] },
  { id: 'ja_hotondo', lang: 'ja', tier: 'A', variants: ['ほとんど', '殆ど'] },
  { id: 'ja_arakajime', lang: 'ja', tier: 'A', variants: ['あらかじめ', '予め'] },
  { id: 'ja_samazama', lang: 'ja', tier: 'A', variants: ['さまざま', '様々'] },
  { id: 'ja_oomune', lang: 'ja', tier: 'A', variants: ['おおむね', '概ね'] },
  { id: 'ja_tadachini', lang: 'ja', tier: 'A', variants: ['ただちに', '直ちに'] },
  { id: 'ja_narabini', lang: 'ja', tier: 'A', variants: ['ならびに', '並びに'], guards: { prevNot: `[${KANJI}]$` } },
  { id: 'ja_sudeni', lang: 'ja', tier: 'A', variants: ['すでに', '既に'] },
  { id: 'ja_futatabi', lang: 'ja', tier: 'A', variants: ['ふたたび', '再び'] },
  { id: 'ja_kiwamete', lang: 'ja', tier: 'A', variants: ['きわめて', '極めて'] },
  { id: 'ja_mattaku', lang: 'ja', tier: 'A', variants: ['まったく', '全く'] },
  { id: 'ja_zehi', lang: 'ja', tier: 'A', variants: ['ぜひ', '是非'] },
  { id: 'ja_iwayuru', lang: 'ja', tier: 'A', variants: ['いわゆる', '所謂'] },
  { id: 'ja_wakaru', lang: 'ja', tier: 'A', variants: ['わかる', '分かる'] },
  { id: 'ja_wakari', lang: 'ja', tier: 'A', variants: ['わかり', '分かり'] },

  // ---- 日本語 tier B: 文頭接続詞ほか ----
  { id: 'ja_tadashi', lang: 'ja', tier: 'B', variants: ['ただし', '但し'], guards: { sentInit: true } },
  { id: 'ja_nao', lang: 'ja', tier: 'B', variants: ['なお', '尚'], guards: { sentInit: true } },
  { id: 'ja_shitagatte', lang: 'ja', tier: 'B', variants: ['したがって', '従って'], guards: { sentInit: true } },
  { id: 'ja_sarani', lang: 'ja', tier: 'B', variants: ['さらに', '更に'], guards: { sentInit: true } },
  { id: 'ja_sunawachi', lang: 'ja', tier: 'B', variants: ['すなわち', '即ち'], guards: { sentInit: true } },
  { id: 'ja_yueni', lang: 'ja', tier: 'B', variants: ['ゆえに', '故に'], guards: { sentInit: true } },
  { id: 'ja_awasete', lang: 'ja', tier: 'B', variants: ['あわせて', '併せて'], guards: { sentInit: true } },
  { id: 'ja_tatoeba', lang: 'ja', tier: 'B', variants: ['たとえば', '例えば'], guards: { sentInit: true } },
  { id: 'ja_hoka', lang: 'ja', tier: 'B', variants: ['ほか', '他'], guards: { prevMust: '[のその]$', nextNot: `^[${KANJI}]` } },
  { id: 'ja_goto', lang: 'ja', tier: 'B', variants: ['ごと', '毎'], guards: { prevMust: `[${KANA}]$`, nextNot: `^[${KANJI}]` } },

  // ---- 日本語 tier B: 高頻度の形式名詞 (容量寄与が大きい) ----
  { id: 'ja_koto', lang: 'ja', tier: 'B', variants: ['こと', '事'], guards: { prevMust: `[${KANA}]$`, nextNot: `^(?:[${KANJI}]|ば|わざ|がら)` } },
  { id: 'ja_toki', lang: 'ja', tier: 'B', variants: ['とき', '時'], guards: { prevMust: `[${KANA}]$`, nextNot: `^(?:[${KANJI}]|どき)` } },
  { id: 'ja_tame', lang: 'ja', tier: 'B', variants: ['ため', '為'], guards: { prevMust: `[${KANA}]$`, nextNot: `^(?:[${KANJI}]|し|ら|る|息)` } },
  { id: 'ja_yoi', lang: 'ja', tier: 'B', variants: ['よい', '良い'], guards: { prevMust: `[${KANA}]$`, nextNot: '^しょ' } },
  { id: 'ja_toori', lang: 'ja', tier: 'B', variants: ['とおり', '通り'], guards: { prevMust: '[のたる]$', nextNot: `^[${KANJI}]` } },

  // ---- 日本語 tier C: 語彙置換 ----
  { id: 'ja_okonau', lang: 'ja', tier: 'C', variants: ['行う', '実施する'], guards: { prevMust: 'を$' } },
  { id: 'ja_shiyou', lang: 'ja', tier: 'C', variants: ['使用する', '利用する'], guards: { prevMust: 'を$' } },
  { id: 'ja_nitsuite', lang: 'ja', tier: 'C', variants: ['について', 'に関して'], guards: { prevNot: `[${KANA}]$` } },

  // ---- 英語 tier A: 語形の揺れ ----
  { id: 'en_toward', lang: 'en', tier: 'A', variants: ['toward', 'towards'] },
  { id: 'en_among', lang: 'en', tier: 'A', variants: ['among', 'amongst'] },
  { id: 'en_while', lang: 'en', tier: 'A', variants: ['while', 'whilst'] },
  { id: 'en_amid', lang: 'en', tier: 'A', variants: ['amid', 'amidst'] },

  // ---- 英語 tier B: 短縮形 ----
  { id: 'en_do_not', lang: 'en', tier: 'B', variants: ['do not', "don't"] },
  { id: 'en_does_not', lang: 'en', tier: 'B', variants: ['does not', "doesn't"] },
  { id: 'en_did_not', lang: 'en', tier: 'B', variants: ['did not', "didn't"] },
  { id: 'en_is_not', lang: 'en', tier: 'B', variants: ['is not', "isn't"] },
  { id: 'en_are_not', lang: 'en', tier: 'B', variants: ['are not', "aren't"] },
  { id: 'en_was_not', lang: 'en', tier: 'B', variants: ['was not', "wasn't"] },
  { id: 'en_were_not', lang: 'en', tier: 'B', variants: ['were not', "weren't"] },
  { id: 'en_will_not', lang: 'en', tier: 'B', variants: ['will not', "won't"] },
  { id: 'en_would_not', lang: 'en', tier: 'B', variants: ['would not', "wouldn't"] },
  { id: 'en_should_not', lang: 'en', tier: 'B', variants: ['should not', "shouldn't"] },
  { id: 'en_could_not', lang: 'en', tier: 'B', variants: ['could not', "couldn't"] },
  { id: 'en_have_not', lang: 'en', tier: 'B', variants: ['have not', "haven't"] },
  { id: 'en_has_not', lang: 'en', tier: 'B', variants: ['has not', "hasn't"] },
  { id: 'en_had_not', lang: 'en', tier: 'B', variants: ['had not', "hadn't"] },
  { id: 'en_cannot', lang: 'en', tier: 'B', variants: ['cannot', "can't"] },
  { id: 'en_it_is', lang: 'en', tier: 'B', variants: ['it is', "it's"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_that_is', lang: 'en', tier: 'B', variants: ['that is', "that's"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_there_is', lang: 'en', tier: 'B', variants: ['there is', "there's"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_we_are', lang: 'en', tier: 'B', variants: ['we are', "we're"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_they_are', lang: 'en', tier: 'B', variants: ['they are', "they're"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_you_are', lang: 'en', tier: 'B', variants: ['you are', "you're"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_i_am', lang: 'en', tier: 'B', variants: ['I am', "I'm"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_let_us', lang: 'en', tier: 'B', variants: ['let us', "let's"] },
  { id: 'en_we_will', lang: 'en', tier: 'B', variants: ['we will', "we'll"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_they_will', lang: 'en', tier: 'B', variants: ['they will', "they'll"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_you_will', lang: 'en', tier: 'B', variants: ['you will', "you'll"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_it_will', lang: 'en', tier: 'B', variants: ['it will', "it'll"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_i_will', lang: 'en', tier: 'B', variants: ['I will', "I'll"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_i_have', lang: 'en', tier: 'B', variants: ['I have', "I've"], guards: { nextNot: '^\\s+not\\b' } },
  { id: 'en_we_have', lang: 'en', tier: 'B', variants: ['we have', "we've"], guards: { nextNot: '^\\s+not\\b' } },

  // ---- 英語 tier C: 語彙置換 ----
  { id: 'en_use', lang: 'en', tier: 'C', variants: ['use', 'utilize'] },
  { id: 'en_uses', lang: 'en', tier: 'C', variants: ['uses', 'utilizes'] },
  { id: 'en_used', lang: 'en', tier: 'C', variants: ['used', 'utilized'] },
  { id: 'en_using', lang: 'en', tier: 'C', variants: ['using', 'utilizing'] },
  { id: 'en_many', lang: 'en', tier: 'C', variants: ['many', 'numerous'] },
  { id: 'en_enough', lang: 'en', tier: 'C', variants: ['enough', 'sufficient'] },
  { id: 'en_often', lang: 'en', tier: 'C', variants: ['often', 'frequently'] },
  { id: 'en_begin', lang: 'en', tier: 'C', variants: ['begin', 'commence'] },
  { id: 'en_help', lang: 'en', tier: 'C', variants: ['help', 'assist'] },
  { id: 'en_need', lang: 'en', tier: 'C', variants: ['need', 'require'] },
  { id: 'en_show', lang: 'en', tier: 'C', variants: ['show', 'demonstrate'] },
  { id: 'en_therefore', lang: 'en', tier: 'C', variants: ['therefore', 'thus'] },
  { id: 'en_however', lang: 'en', tier: 'C', variants: ['however', 'nevertheless'] },
  { id: 'en_moreover', lang: 'en', tier: 'C', variants: ['moreover', 'furthermore'] },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_DICT };
}
