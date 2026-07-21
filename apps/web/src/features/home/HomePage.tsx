import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "@/shared/api/client";
import styles from "./HomePage.module.css";

export function HomePage() {
  const [empty, setEmpty] = useState(true);
  const [keyConfigured, setKeyConfigured] = useState(false);

  useEffect(() => {
    void api.overview().then((data) => {
      setEmpty(data.empty_library);
      setKeyConfigured(data.key_configured);
    });
  }, []);

  return (
    <section className={styles.page}>
      <p className={styles.eyebrow}>首页</p>
      <h1 className={styles.brand}>空库</h1>
      <h2 className={styles.title}>
        {empty ? "默认没有知识，需要你来喂养" : "知识已在积累，继续投递或去对话"}
      </h2>
      <p className={styles.desc}>
        投递电子书、笔记或视频链接；视频可自动提取文案，无需手贴文稿。AI
        帮你总结归类。对话只按库内作答，超出范围会拒答。
      </p>
      <div className={styles.actions}>
        <Link className={styles.primary} to="/feed">
          开始喂养
        </Link>
        <Link className={styles.ghost} to="/settings">
          {keyConfigured ? "查看模型配置" : "配置 API Key"}
        </Link>
      </div>
      <ul className={styles.principles}>
        <li>
          <strong>空库起步</strong>
          <span>没有预置百科，你喂什么它懂什么</span>
        </li>
        <li>
          <strong>视频自动提取文案</strong>
          <span>字幕优先，失败再转写</span>
        </li>
        <li>
          <strong>只按库内答</strong>
          <span>超出范围明确拒答，保护认知质量</span>
        </li>
      </ul>
    </section>
  );
}
