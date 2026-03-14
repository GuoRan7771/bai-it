import { describe, it, expect, beforeEach } from "vitest";
import {
  loadFrequencyList,
  loadDictionary,
  loadLemmaMap,
  setFrequencyLimit,
  annotateWords,
  isCommonWord,
  toNewWordsFormat,
  resetAll,
} from "../shared/vocab";

import frequencyWords from "../../tests/fixtures/word-frequency-test.json";
import dictEntries from "../../tests/fixtures/dict-test.json";

beforeEach(() => {
  resetAll();
  loadFrequencyList("english", frequencyWords);
  loadDictionary("english", dictEntries);
});

// ========== 验收标准：词频过滤 ==========

describe("词频过滤", () => {
  it("常用词不标注", () => {
    const result = annotateWords(
      "The team will develop a new project for the company.",
      new Set(),
      "english",
    );
    // "team", "develop", "project", "company" 都在常用词表中
    const annotatedWords = result.map(a => a.word);
    expect(annotatedWords).not.toContain("team");
    expect(annotatedWords).not.toContain("develop");
    expect(annotatedWords).not.toContain("project");
    expect(annotatedWords).not.toContain("company");
  });

  it("超出词频表的词标注", () => {
    const result = annotateWords(
      "The algorithm uses a heuristic approach to refactor the codebase.",
      new Set(),
      "english",
    );
    const annotatedWords = result.map(a => a.word);
    expect(annotatedWords).toContain("algorithm");
    expect(annotatedWords).toContain("heuristic");
    expect(annotatedWords).toContain("refactor");
  });

  it("isCommonWord 正确判断", () => {
    expect(isCommonWord("the", "english")).toBe(true);
    expect(isCommonWord("algorithm", "english")).toBe(false);
    expect(isCommonWord("The", "english")).toBe(true); // 大小写不敏感
  });

  it("太短的词不标注", () => {
    const result = annotateWords("Is it OK to go?", new Set(), "english");
    const annotatedWords = result.map(a => a.word);
    // "is", "it", "ok", "to", "go" 都太短（< 3 字母）或在常用词中
    expect(annotatedWords.length).toBe(0);
  });

  it("纯数字不标注", () => {
    const result = annotateWords("There are 12345 items.", new Set(), "english");
    const annotatedWords = result.map(a => a.word);
    expect(annotatedWords).not.toContain("12345");
  });
});

// ========== 验收标准：AI 义项已合并到词典 ==========

describe("AI义项合并到词典", () => {
  it("含 AI 义项的词通过词典标注", () => {
    const result = annotateWords(
      "The model suffers from hallucination during inference.",
      new Set(),
      "english",
    );
    const hallucination = result.find(a => a.word === "hallucination");
    expect(hallucination).toBeDefined();
    expect(hallucination!.definition).toContain("[AI]");

    const inference = result.find(a => a.word === "inference");
    expect(inference).toBeDefined();
    expect(inference!.definition).toContain("[AI]");
  });

  it("词典释义同时包含通用和 AI 义项", () => {
    const result = annotateWords(
      "The latent space representation captures semantic features.",
      new Set(),
      "english",
    );
    const latent = result.find(a => a.word === "latent");
    expect(latent).toBeDefined();
    // 既有通用释义又有 AI 释义
    expect(latent!.definition).toContain("潜在的");
    expect(latent!.definition).toContain("[AI]");
  });

  it("纯 AI 术语也能通过词典标注", () => {
    const result = annotateWords(
      "Backpropagation and overfitting are key ML concepts.",
      new Set(),
      "english",
    );
    const bp = result.find(a => a.word === "backpropagation");
    expect(bp).toBeDefined();
    expect(bp!.definition).toContain("反向传播");

    const of_ = result.find(a => a.word === "overfitting");
    expect(of_).toBeDefined();
    expect(of_!.definition).toContain("过拟合");
  });
});

// ========== 验收标准：已知词跳过 ==========

describe("已知词跳过", () => {
  it("标记为已掌握的词不再标注", () => {
    const known = new Set(["algorithm", "refactor"]);
    const result = annotateWords(
      "The algorithm helps refactor the infrastructure for better deployment.",
      known,
      "english",
    );
    const annotatedWords = result.map(a => a.word);
    expect(annotatedWords).not.toContain("algorithm");
    expect(annotatedWords).not.toContain("refactor");
    // infrastructure 和 deployment 不在已知词中，应该被标注
    expect(annotatedWords).toContain("infrastructure");
    expect(annotatedWords).toContain("deployment");
  });

  it("已知词大小写不敏感", () => {
    const known = new Set(["algorithm"]);
    const result = annotateWords("Algorithm is important.", known, "english");
    const annotatedWords = result.map(a => a.word);
    expect(annotatedWords).not.toContain("algorithm");
  });

  it("空已知词集不影响标注", () => {
    const result = annotateWords(
      "The algorithm uses heuristic methods.",
      new Set(),
      "english",
    );
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("法语支持", () => {
  beforeEach(() => {
    loadFrequencyList("french", [
      "être", "avoir", "aller", "faire", "pouvoir", "vouloir", "venir", "prendre",
      "voir", "savoir", "devoir", "dire", "mettre", "tenir", "projet", "équipe", "retard",
    ]);
    loadDictionary("french", {
      projet: "n. 项目",
      algorithme: "n. 算法",
      heuristique: "adj./n. 启发式的；启发法",
      robuste: "adj. 稳健的",
      livraison: "n. 交付",
      chercheur: "n. 研究人员",
      fiable: "adj. 可靠的",
      français: "n. 法语；法文",
      écrire: "v. 写；寫",
      répondre: "v. 回答；答应",
      conduire: "v. 带领；开",
      publier: "v. 发布；发表",
      connaître: "v. 认识；了解",
      somme: "n. 总和",
      fait: "n. 事实",
    });
    loadLemmaMap("french", {
      robustes: "robuste",
      livraisons: "livraison",
      algorithmes: "algorithme",
      françaises: "français",
    });
  });

  it("法语常用词不标注，但较难词会标注", () => {
    const result = annotateWords(
      "Le projet de l'équipe utilise un algorithme robuste.",
      new Set(),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);
    expect(annotatedWords).toContain("algorithme");
    expect(annotatedWords).toContain("robuste");
    expect(annotatedWords).not.toContain("projet");
  });

  it("法语 lemma 映射生效", () => {
    expect(isCommonWord("algorithmes", "french")).toBe(false);
    const result = annotateWords(
      "Les livraisons robustes rassurent l'équipe.",
      new Set(),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);
    expect(annotatedWords).toContain("livraisons");
    expect(annotatedWords).toContain("robustes");
  });

  it("法语优先使用 lemma 基础形释义，避免变体词头覆盖", () => {
    loadDictionary("french", {
      chercheur: "n. 研究人员",
      chercheurs: "n. 头面人物",
    });
    loadLemmaMap("french", {
      chercheurs: "chercheur",
    });

    const result = annotateWords(
      "Les chercheurs publient rapidement leurs résultats.",
      new Set(),
      "french",
    );

    const chercheurs = result.find((a) => a.word === "chercheurs");
    expect(chercheurs).toBeDefined();
    expect(chercheurs!.definition).toContain("研究人员");
  });

  it("法语规则变位和性数变化可以回落到基础形词典", () => {
    const result = annotateWords(
      "Chercheuses fiables publient rapidement de nouvelles notes.",
      new Set(),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);

    expect(annotatedWords).toContain("chercheuses");
    expect(annotatedWords).toContain("fiables");
    expect(annotatedWords).toContain("publient");

    expect(result.find((a) => a.word === "chercheuses")!.definition).toContain("研究人员");
    expect(result.find((a) => a.word === "fiables")!.definition).toContain("可靠");
    expect(result.find((a) => a.word === "publient")!.definition).toContain("发布");
  });

  it("法语不规则高频变位不会误命中同形异义词", () => {
    const result = annotateWords(
      "Nous sommes prets et il fait beau.",
      new Set(),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);

    expect(annotatedWords).not.toContain("sommes");
    expect(annotatedWords).not.toContain("fait");
  });

  it("法语已掌握基础形可以覆盖变位和变体", () => {
    const result = annotateWords(
      "Les chercheuses publient rapidement.",
      new Set(["chercheur", "publier"]),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);

    expect(annotatedWords).not.toContain("chercheuses");
    expect(annotatedWords).not.toContain("publient");
  });

  it("法语大小写差异不影响命中", () => {
    const result = annotateWords(
      "Chercheuses Publient des rapports fiables.",
      new Set(),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);

    expect(annotatedWords).toContain("chercheuses");
    expect(annotatedWords).toContain("publient");
    expect(annotatedWords).toContain("fiables");
  });

  it("法语无重音的大写变体也能通过 lemma 命中基础词头", () => {
    const result = annotateWords(
      "FRANCAISES",
      new Set(),
      "french",
    );
    const francaises = result.find((a) => a.word === "francaises");

    expect(francaises).toBeDefined();
    expect(francaises!.definition).toContain("法语");
  });

  it("法语会沿着 lemma 链继续回落到更基础的词头", () => {
    loadDictionary("french", {
      connu: "n. 名牌",
      connaître: "v. 认识；了解",
    });
    loadLemmaMap("french", {
      connues: "connu",
      connu: "connaître",
    });

    const result = annotateWords(
      "Des personnes connues arrivent.",
      new Set(),
      "french",
    );
    const connues = result.find((a) => a.word === "connues");

    expect(connues).toBeDefined();
    expect(connues!.definition).toContain("认识");
  });

  it("法语已掌握词大小写不一致时仍能覆盖变体", () => {
    const result = annotateWords(
      "Chercheuses Publient rapidement.",
      new Set(["Chercheur", "Publier"]),
      "french",
    );
    const annotatedWords = result.map((a) => a.word);

    expect(annotatedWords).not.toContain("chercheuses");
    expect(annotatedWords).not.toContain("publient");
  });

  it("法语词汇量阈值可以调整高频词是否显示", () => {
    expect(isCommonWord("projet", "french")).toBe(true);

    setFrequencyLimit("french", 0);

    expect(isCommonWord("projet", "french")).toBe(false);
    const result = annotateWords(
      "Le projet avance.",
      new Set(),
      "french",
    );
    expect(result.map((a) => a.word)).toContain("projet");
  });

  it("英语词汇量阈值可以调整高频词是否显示", () => {
    loadDictionary("english", {
      project: "n. 项目",
    });

    expect(isCommonWord("project", "english")).toBe(true);

    setFrequencyLimit("english", 0);

    expect(isCommonWord("project", "english")).toBe(false);
    const result = annotateWords(
      "The project ships today.",
      new Set(),
      "english",
    );
    expect(result.map((a) => a.word)).toContain("project");
  });

  it("英语可以关闭所有词汇提示", () => {
    setFrequencyLimit("english", -1);

    expect(isCommonWord("algorithm", "english")).toBe(false);
    expect(
      annotateWords("The algorithm is great.", new Set(), "english")
    ).toEqual([]);
  });

  it("法语可以关闭所有词汇提示", () => {
    setFrequencyLimit("french", -1);

    expect(isCommonWord("projet", "french")).toBe(false);
    expect(
      annotateWords("Le projet avance.", new Set(), "french")
    ).toEqual([]);
  });

  it("法语常见人称变位会优先回落到动词原形释义", () => {
    loadDictionary("french", {
      demande: "n. 请求",
      demander: "v. 问",
    });
    loadLemmaMap("french", {
      demande: "demander",
    });

    const result = annotateWords(
      "Je demande un conseil.",
      new Set(),
      "french",
    );
    const demande = result.find((a) => a.word === "demande");

    expect(demande).toBeDefined();
    expect(demande!.definition).toContain("问");
  });

  it("法语将来时和条件式变位可以回落到基础形词典", () => {
    const result = annotateWords(
      "Ils écriraient et répondraient pendant que nous publierions.",
      new Set(),
      "french",
    );

    expect(result.find((a) => a.word === "écriraient")!.definition).toContain("写");
    expect(result.find((a) => a.word === "répondraient")!.definition).toContain("回答");
    expect(result.find((a) => a.word === "publierions")!.definition).toContain("发布");
  });

  it("法语第三组动词的不同时态人称也能命中基础形", () => {
    const result = annotateWords(
      "Ils conduisaient pendant que j'écrivais.",
      new Set(),
      "french",
    );

    expect(result.find((a) => a.word === "conduisaient")!.definition).toContain("带领");
    expect(result.find((a) => a.word === "écrivais")!.definition).toContain("写");
  });

  it("法语常见非规则动词的时态变位会正确回落并参与常用词过滤", () => {
    expect(isCommonWord("seraient", "french")).toBe(true);
    expect(isCommonWord("auraient", "french")).toBe(true);
    expect(isCommonWord("allions", "french")).toBe(true);
    expect(isCommonWord("feraient", "french")).toBe(true);
    expect(isCommonWord("puissent", "french")).toBe(true);
  });

  it("法语已掌握词按语言过滤", () => {
    const result = annotateWords(
      "Un algorithme heuristique peut rester robuste.",
      new Set(["algorithme"]),
      "french",
    );
    const annotatedWords = result.map(a => a.word);
    expect(annotatedWords).not.toContain("algorithme");
    expect(annotatedWords).toContain("heuristique");
  });
});

// ========== 辅助功能 ==========

describe("辅助功能", () => {
  it("toNewWordsFormat 正确转换", () => {
    const annotations = annotateWords(
      "The algorithm uses immutable data.",
      new Set(),
      "english",
    );
    const newWords = toNewWordsFormat(annotations);
    expect(newWords.length).toBe(annotations.length);
    for (const nw of newWords) {
      expect(nw).toHaveProperty("word");
      expect(nw).toHaveProperty("definition");
    }
  });

  it("同一词不重复标注", () => {
    const result = annotateWords(
      "The algorithm is a good algorithm. Another algorithm here.",
      new Set(),
      "english",
    );
    const algorithmAnnotations = result.filter(a => a.word === "algorithm");
    expect(algorithmAnnotations.length).toBe(1);
  });

  it("未加载数据时返回空数组", () => {
    resetAll();
    const result = annotateWords("The algorithm is great.", new Set(), "english");
    expect(result).toEqual([]);
  });

  it("无英文单词的文本返回空", () => {
    const result = annotateWords("这是一段中文文本 12345", new Set(), "english");
    expect(result).toEqual([]);
  });
});
