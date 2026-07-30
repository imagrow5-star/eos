// ─── Crisis patterns — non-English languages ─────────────────────────────────
// LIFE-SAFETY CODE. One pattern set per activated language, matched IN
// ADDITION to the English set (union — a user chatting in German can still
// type an English crisis phrase; both must fire). Deliberately conservative:
// a false positive shows a dismissible support card; a false negative can
// miss a real crisis. When in doubt a phrase was INCLUDED.
//
// Sources used to assemble each set (drafted from these, then composed by
// hand — never machine-translated):
//  • the phrase families used by the national helplines the crisis floor
//    already points to (Telefonseelsorge/DE, 113 Zelfmoordpreventie/NL,
//    3114/FR, Teléfono/Línea 024 material/ES, Telefono Amico/IT, SOS Voz
//    Amiga & CVV/PT, Mind Självmordslinjen/SE, Mental Helse/NO,
//    Livslinien/DK, Centrum Wsparcia/PL) as described in their public
//    "warning signs / how to ask" guidance;
//  • published crisis-intervention phrase lists (WHO "Preventing suicide: a
//    resource" language adaptations; IASP warning-signs material);
//  • direct/veiled/method/burden coverage mirroring the English set
//    (services/crisis/detector.ts).
// EVERY pattern below needs NATIVE-SPEAKER REVIEW as a founder follow-up —
// the per-language comments list the exact phrases covered to make that
// review a read-through, not an archaeology dig.
//
// Regex notes:
//  • JavaScript's \b is ASCII-only and breaks next to letters like ä/ø/ż, so
//    these patterns are written WITHOUT \b and compiled by the detector with
//    unicode-aware boundaries: (?<![\p{L}\p{N}]) … (?![\p{L}\p{N}]) + "iu".
//  • Diacritics are optional everywhere ([äa], [ęe]…) — people type fast,
//    on foreign keyboards, in crisis.

export interface I18nCrisisPattern {
  /** Recorded in crisis_events.pattern_matched, e.g. "de_want_to_die". */
  name: string;
  /** Pattern SOURCE (no \b, no flags) — compiled with unicode boundaries. */
  source: string;
}

export const I18N_CRISIS_PATTERNS: Record<string, I18nCrisisPattern[]> = {
  // ── German — phrases covered: sich umbringen / Suizid / Selbstmord /
  // sich das Leben nehmen / dem Leben ein Ende setzen(machen) / (nur noch)
  // sterben wollen / nicht mehr leben wollen / nicht mehr hier sein, aufwachen,
  // existieren wollen / wäre lieber tot / wünschte ich wäre tot / alle wären
  // besser dran ohne mich / mir etwas antun / mich (selbst) verletzen /
  // Selbstverletzung / Überdosis / kein Ausweg / kann nicht mehr weiter /
  // kann so nicht mehr leben / für immer verschwinden / nicht mehr aufwachen
  de: [
    { name: "de_kill_myself", source: "(mich|mich selbst) (umbringen|umzubringen|t[öo]ten)|bring(e)? mich um" },
    { name: "de_suicide_reference", source: "suizid\\w*|selbstmord\\w*|selbstt[öo]tung\\w*" },
    { name: "de_take_my_life", source: "(mir|sich) das leben (zu )?nehmen" },
    { name: "de_end_my_life", source: "(meinem|dem) leben ein ende (setzen|machen|bereiten)" },
    { name: "de_want_to_die", source: "(will|m[öo]chte|wollte|w[üu]rde gern(e)?) (nur noch |am liebsten )?sterben|will nicht mehr leben|m[öo]chte nicht mehr leben" },
    { name: "de_passive_ideation", source: "will nicht mehr (hier sein|da sein|aufwachen|existieren)|nicht mehr aufwachen wollen" },
    { name: "de_wish_dead", source: "w[äa]re (am )?liebsten tot|w[üu]nschte,? ich w[äa]re tot" },
    { name: "de_burden_belief", source: "besser (dran )?ohne mich" },
    { name: "de_self_harm", source: "mir (et)?was antun|mich (selbst )?verletz\\w*|selbstverletzung\\w*" },
    { name: "de_overdose", source: "[üu]berdosis" },
    { name: "de_no_way_out", source: "kein(en)? ausweg( mehr)?" },
    { name: "de_cant_go_on", source: "kann (einfach )?nicht mehr (weiter|weitermachen)|kann so nicht mehr leben" },
    { name: "de_disappear_forever", source: "f[üu]r immer verschwinden" },
  ],

  // ── Dutch — phrases covered: zelfmoord / zelfdoding / suïcide / een einde
  // aan (mijn leven / eraan) maken / dood willen / willen sterven / niet meer
  // willen leven / er niet meer willen zijn / niet meer wakker willen worden /
  // liever dood / was ik maar dood / beter af zonder mij / mezelf iets aandoen
  // / mezelf pijn doen, snijden / zelfbeschadiging, automutilatie / overdosis /
  // geen uitweg / kan zo niet verder / trek het niet meer / voor altijd
  // verdwijnen / geen zin meer in het leven
  nl: [
    { name: "nl_suicide_reference", source: "zelfmoord\\w*|zelfdoding\\w*|su[ïi]cid\\w*" },
    { name: "nl_end_my_life", source: "een einde aan (mijn leven|eraan) (te )?maken|er een einde aan (te )?maken" },
    { name: "nl_want_to_die", source: "wil (het liefst )?(dood|sterven)|wil niet meer leven|wilde sterven" },
    { name: "nl_passive_ideation", source: "wil er niet meer zijn|wil niet meer wakker worden|wil niet meer bestaan" },
    { name: "nl_wish_dead", source: "was ik maar dood|liever dood" },
    { name: "nl_burden_belief", source: "beter af zonder mij" },
    { name: "nl_self_harm", source: "mezelf (iets|wat) aandoen|mezelf pijn doen|mezelf snijden|zelfbeschadiging\\w*|automutilatie\\w*" },
    { name: "nl_overdose", source: "overdosis" },
    { name: "nl_no_way_out", source: "geen uitweg( meer)?" },
    { name: "nl_cant_go_on", source: "kan zo niet (meer )?(verder|leven)|trek het niet meer" },
    { name: "nl_disappear_forever", source: "voor altijd verdwijnen" },
    { name: "nl_life_no_point", source: "geen zin meer in het leven|leven heeft geen zin( meer)?" },
  ],

  // ── French — phrases covered: me suicider / me tuer / suicide, suicidaire /
  // en finir (avec la vie, avec tout / envie d'en finir) / mettre fin à mes
  // jours, à ma vie / (je) veux mourir, envie de mourir, voudrais mourir / ne
  // plus vouloir vivre, être là, me réveiller, exister / aimerais être mort(e),
  // préférerais être mort(e) / mieux sans moi / me faire du mal / me mutiler,
  // me scarifier, automutilation, scarification / surdose, overdose / aucune
  // issue, aucune échappatoire / plus la force de vivre, de continuer /
  // disparaître pour toujours / (vie qui ne) vaut pas la peine d'être vécue
  fr: [
    { name: "fr_kill_myself", source: "me (suicider|tuer)|suicid\\w*" },
    { name: "fr_end_it_all", source: "envie d'en finir|en finir avec (la vie|tout)|mettre fin [àa] (mes jours|ma vie)|fin [àa] mes jours" },
    { name: "fr_want_to_die", source: "(je )?veux mourir|envie de mourir|voudrais mourir" },
    { name: "fr_passive_ideation", source: "ne veux plus ([êe]tre l[àa]|vivre|me r[ée]veiller|exister)|veux plus (vivre|[êe]tre l[àa])" },
    { name: "fr_wish_dead", source: "(aimerais|pr[ée]f[ée]rerais|voudrais) [êe]tre mort(e)?" },
    { name: "fr_burden_belief", source: "mieux sans moi" },
    { name: "fr_self_harm", source: "me faire du mal|me mutiler|me scarifier|automutilation\\w*|scarification\\w*" },
    { name: "fr_overdose", source: "surdose|overdose" },
    { name: "fr_no_way_out", source: "aucune (issue|[ée]chappatoire)" },
    { name: "fr_cant_go_on", source: "plus la force de (vivre|continuer)" },
    { name: "fr_disappear_forever", source: "dispara[îi]tre pour toujours" },
    { name: "fr_life_not_worth", source: "vaut (pas|plus) la peine d'[êe]tre v[ée]cue" },
  ],

  // ── Spanish — phrases covered: suicidarme, suicidio, suicida / matarme /
  // quitarme la vida / quiero morir(me), quisiera morir, ganas de morir / no
  // quiero vivir, seguir viviendo, estar aquí, existir, despertar / quisiera
  // estar muerto(a), ojalá estuviera muerto(a) / acabar con todo, con mi vida /
  // terminar con mi vida / mejor sin mí / hacerme daño / cortarme / autolesión
  // / no puedo más (Línea 024 guidance lists it — deliberately included even
  // though it can be plain exhaustion; err to include) / sobredosis / sin
  // salida, no hay salida / desaparecer para siempre / no vale la pena vivir
  es: [
    { name: "es_kill_myself", source: "suicid\\w*|matarme|quitarme la vida" },
    { name: "es_want_to_die", source: "quiero morir(me)?|quisiera morir\\w*|ganas de morir\\w*" },
    { name: "es_passive_ideation", source: "no quiero (vivir|seguir viviendo|estar aqu[íi]|existir|despertar)" },
    { name: "es_wish_dead", source: "(quisiera|ojal[áa]) estar muert[oa]|estuviera muert[oa]" },
    { name: "es_end_it_all", source: "acabar con (todo|mi vida)|terminar con mi vida" },
    { name: "es_burden_belief", source: "mejor sin m[íi]" },
    { name: "es_self_harm", source: "hacerme da[ñn]o|cortarme|autolesi[óo]n\\w*" },
    { name: "es_cant_go_on", source: "no puedo m[áa]s" },
    { name: "es_overdose", source: "sobredosis" },
    { name: "es_no_way_out", source: "sin salida|no hay salida" },
    { name: "es_disappear_forever", source: "desaparecer para siempre" },
    { name: "es_life_not_worth", source: "no vale la pena vivir\\w*" },
  ],

  // ── Italian — phrases covered: suicidarmi, suicidio / uccidermi, ammazzarmi
  // / togliermi la vita / farla finita (classic idiom — included whole) /
  // voglio morire, vorrei morire, voglia di morire / non voglio più vivere,
  // esserci, esistere, svegliarmi / vorrei essere morto(a), fossi morto(a) /
  // meglio senza di me / farmi del male / tagliarmi / autolesionismo / non ce
  // la faccio più (Telefono Amico guidance-family phrase — included) /
  // overdose / nessuna(senza) via d'uscita / sparire per sempre / non vale la
  // pena (di) vivere
  it: [
    { name: "it_kill_myself", source: "suicid\\w*|uccidermi|ammazzarmi|togliermi la vita" },
    { name: "it_end_it_all", source: "farla finita" },
    { name: "it_want_to_die", source: "voglio morire|vorrei morire|voglia di morire" },
    { name: "it_passive_ideation", source: "non voglio pi[ùu] (vivere|esserci|esistere|svegliarmi)" },
    { name: "it_wish_dead", source: "vorrei essere mort[oa]|fossi mort[oa]" },
    { name: "it_burden_belief", source: "meglio senza di me" },
    { name: "it_self_harm", source: "farmi del male|tagliarmi|autolesionism\\w*" },
    { name: "it_cant_go_on", source: "non ce la faccio pi[ùu]" },
    { name: "it_overdose", source: "overdose" },
    { name: "it_no_way_out", source: "(nessuna|senza) via d'uscita" },
    { name: "it_disappear_forever", source: "sparire per sempre" },
    { name: "it_life_not_worth", source: "non vale la pena (di )?vivere" },
  ],

  // ── Portuguese (EU + BR forms) — phrases covered: suicidar-me, suicídio /
  // me matar, matar-me / tirar (a) minha (própria) vida / quero morrer, queria
  // morrer, vontade de morrer / não quero (mais) viver, estar aqui, existir,
  // acordar / queria estar morto(a), estivesse morto(a) / acabar com tudo, com
  // a minha vida / melhor sem mim / me machucar (BR), magoar-me (PT), me
  // cortar / automutilação, autolesão / não aguento mais (CVV guidance-family
  // phrase — included) / overdose / sem saída / desaparecer para sempre / não
  // vale a pena viver
  pt: [
    { name: "pt_kill_myself", source: "suic[íi]d\\w*|me matar|matar-me|tirar (a )?minha (pr[óo]pria )?vida" },
    { name: "pt_want_to_die", source: "quero morrer|queria morrer|vontade de morrer" },
    { name: "pt_passive_ideation", source: "n[ãa]o quero (mais )?(viver|estar aqui|existir|acordar)" },
    { name: "pt_wish_dead", source: "(queria|quisera) estar mort[oa]|estivesse mort[oa]" },
    { name: "pt_end_it_all", source: "acabar com (tudo|a minha vida|minha vida)" },
    { name: "pt_burden_belief", source: "melhor sem mim" },
    { name: "pt_self_harm", source: "me (machucar|cortar|ferir)|magoar-me|automutila[çc][ãa]o\\w*|autoles[ãa]o\\w*" },
    { name: "pt_cant_go_on", source: "n[ãa]o aguento mais" },
    { name: "pt_overdose", source: "overdose" },
    { name: "pt_no_way_out", source: "sem sa[íi]da" },
    { name: "pt_disappear_forever", source: "desaparecer para sempre" },
    { name: "pt_life_not_worth", source: "n[ãa]o vale a pena viver" },
  ],

  // ── Swedish — phrases covered: självmord / suicid / ta livet av mig, ta
  // mitt liv / vill (bara) dö / vill inte leva, finnas, vakna, vara här
  // (längre/mer) / önskar (att) jag vore död / göra slut på allt, mitt liv /
  // bättre utan mig / skada mig (själv), skära mig, självskada / orkar inte
  // mer/längre (Mind's guidance-family phrase — included) / ingen utväg /
  // överdos / försvinna för alltid
  sv: [
    { name: "sv_suicide_reference", source: "sj[äa]lvmord\\w*|suicid\\w*" },
    { name: "sv_take_my_life", source: "ta livet av mig|ta mitt (eget )?liv" },
    { name: "sv_want_to_die", source: "vill (bara )?d[öo]|ville d[öo]" },
    { name: "sv_passive_ideation", source: "vill inte (leva|finnas|vakna|vara h[äa]r)( l[äa]ngre| mer)?" },
    { name: "sv_wish_dead", source: "[öo]nskar (att )?jag vore d[öo]d|vore hellre d[öo]d" },
    { name: "sv_end_it_all", source: "g[öo]ra slut p[åa] (allt|mitt liv)" },
    { name: "sv_burden_belief", source: "b[äa]ttre utan mig" },
    { name: "sv_self_harm", source: "skada mig( sj[äa]lv)?|sk[äa]ra mig|sj[äa]lvskad\\w*" },
    { name: "sv_cant_go_on", source: "orkar inte (mer|l[äa]ngre)" },
    { name: "sv_overdose", source: "[öo]verdos\\w*" },
    { name: "sv_no_way_out", source: "ingen utv[äa]g" },
    { name: "sv_disappear_forever", source: "f[öo]rsvinna f[öo]r alltid" },
  ],

  // ── Norwegian — phrases covered: selvmord / suicid / ta livet mitt, ta
  // livet av meg / vil (bare) dø / vil ikke leve, være her, våkne, finnes
  // (lenger/mer) / skulle ønske jeg var død / gjøre slutt på alt, livet /
  // bedre uten meg / skade meg (selv), kutte meg, selvskading / orker ikke
  // mer/lenger (Mental Helse guidance-family — included) / ingen utvei /
  // overdose / forsvinne for alltid
  no: [
    { name: "no_suicide_reference", source: "selvmord\\w*|suicid\\w*" },
    { name: "no_take_my_life", source: "ta livet (mitt|av meg)" },
    { name: "no_want_to_die", source: "vil (bare )?d[øo]|ville d[øo]" },
    { name: "no_passive_ideation", source: "vil ikke (leve|v[æa]re her|v[åa]kne|finnes)( lenger| mer)?" },
    { name: "no_wish_dead", source: "[øo]nske (at )?jeg var d[øo]d" },
    { name: "no_end_it_all", source: "gj[øo]re slutt p[åa] (alt|livet)" },
    { name: "no_burden_belief", source: "bedre uten meg" },
    { name: "no_self_harm", source: "skade meg( selv)?|kutte meg|selvskad\\w*" },
    { name: "no_cant_go_on", source: "orker ikke (mer|lenger)" },
    { name: "no_overdose", source: "overdose\\w*" },
    { name: "no_no_way_out", source: "ingen utvei" },
    { name: "no_disappear_forever", source: "forsvinne for alltid" },
  ],

  // ── Danish — phrases covered: selvmord / tage mit (eget) liv / slå mig selv
  // ihjel / vil (bare) dø / ønsker jeg var død / vil ikke leve, være her,
  // vågne, findes (længere/mere) / gøre en ende på det hele, mit liv / bedre
  // uden mig / gøre skade på mig selv, skære i mig selv, selvskade / kan ikke
  // mere, magter ikke mere (Livslinien guidance-family — included) / ingen
  // udvej / overdosis / forsvinde for altid
  da: [
    { name: "da_suicide_reference", source: "selvmord\\w*" },
    { name: "da_take_my_life", source: "tage mit( eget)? liv|sl[åa] mig selv ihjel" },
    { name: "da_want_to_die", source: "vil (bare )?d[øo]|ville d[øo]" },
    { name: "da_wish_dead", source: "[øo]nsker (at )?jeg var d[øo]d" },
    { name: "da_passive_ideation", source: "vil ikke (leve|v[æa]re her|v[åa]gne|findes)( l[æa]ngere| mere)?" },
    { name: "da_end_it_all", source: "g[øo]re en ende p[åa] (det hele|mit liv)" },
    { name: "da_burden_belief", source: "bedre uden mig" },
    { name: "da_self_harm", source: "skade p[åa] mig selv|sk[æa]re i mig selv|selvskad\\w*" },
    { name: "da_cant_go_on", source: "(kan|magter) ikke (mere|klare mere)" },
    { name: "da_overdose", source: "overdosis" },
    { name: "da_no_way_out", source: "ingen udvej" },
    { name: "da_disappear_forever", source: "forsvinde for altid" },
  ],

  // ── Polish — phrases covered: samobójstwo, samobójcze (myśli) / zabić się /
  // odebrać sobie życie / chcę umrzeć, chciał(a)bym umrzeć / nie chcę (już)
  // żyć, tu być, istnieć, się budzić / nie chce mi się żyć / wolał(a)bym nie
  // żyć / skończyć ze sobą, z tym wszystkim / lepiej beze mnie / zrobić sobie
  // krzywdę / samookaleczenie, okaleczyć się / nie mam siły żyć, dłużej /
  // przedawkować, przedawkowanie / nie ma wyjścia, bez wyjścia / zniknąć na
  // zawsze
  pl: [
    { name: "pl_suicide_reference", source: "samob[óo]j\\w*" },
    { name: "pl_kill_myself", source: "zabi[ćc] si[ęe]|odebra[ćc] sobie [żz]ycie" },
    { name: "pl_want_to_die", source: "chc[ęe] umrze[ćc]|chcia[łl](a)?bym umrze[ćc]" },
    { name: "pl_passive_ideation", source: "nie chc[ęe] (ju[żz] )?([żz]y[ćc]|tu by[ćc]|istnie[ćc]|si[ęe] budzi[ćc])|nie chce mi si[ęe] [żz]y[ćc]" },
    { name: "pl_wish_dead", source: "wola[łl](a)?bym nie [żz]y[ćc]" },
    { name: "pl_end_it_all", source: "sko[ńn]czy[ćc] ze sob[ąa]|sko[ńn]czy[ćc] z (tym )?wszystkim" },
    { name: "pl_burden_belief", source: "lepiej beze mnie" },
    { name: "pl_self_harm", source: "zrobi[ćc] sobie krzywd[ęe]|samookaleczen\\w*|okaleczy[ćc] si[ęe]" },
    { name: "pl_cant_go_on", source: "nie mam si[łl]y ([żz]y[ćc]|d[łl]u[żz]ej)" },
    { name: "pl_overdose", source: "przedawkow\\w*" },
    { name: "pl_no_way_out", source: "nie ma wyj[śs]cia|bez wyj[śs]cia" },
    { name: "pl_disappear_forever", source: "znikn[ąa][ćc] na zawsze" },
  ],
};
