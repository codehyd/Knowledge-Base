import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  HomeOutlined,
  PlayCircleOutlined,
  RightOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
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
      <div className={styles.breadcrumb}>
        <HomeOutlined />
        <span>首页</span>
      </div>

      <div className={styles.hero}>
        <h1 className={styles.brand}>
          <img
            src={`${import.meta.env.BASE_URL}logo-wordmark.png`}
            alt="空库"
            className={styles.brandLogo}
          />
        </h1>
        <h2 className={styles.title}>
          {empty ? "默认没有知识，需要你来喂养" : "知识已在积累，继续投递或去对话"}
        </h2>
        <p className={styles.desc}>
          投递电子书、笔记或视频链接；视频可自动提取文案，无需手贴文稿。AI
          帮你总结归类。
        </p>

        <div className={styles.actions}>
          <Link className={styles.primary} to="/feed">
            开始喂养
          </Link>
          <Link className={styles.ghost} to="/settings">
            {keyConfigured ? "查看模型配置" : "配置 API Key"}
          </Link>
          <a className={styles.textLink} href="#principles">
            查看使用说明
            <RightOutlined />
          </a>
        </div>
      </div>

      <ul id="principles" className={styles.principles}>
        <li>
          <RiseOutlined className={styles.pIcon} />
          <div>
            <strong>空库起步</strong>
            <span>从投递开始，逐步构建你的专属知识库。</span>
          </div>
        </li>
        <li>
          <PlayCircleOutlined className={styles.pIcon} />
          <div>
            <strong>视频自动提取文案</strong>
            <span>粘贴视频链接，自动提取文案，无需手贴文稿。</span>
          </div>
        </li>
        <li>
          <SafetyCertificateOutlined className={styles.pIcon} />
          <div>
            <strong>只按库内答</strong>
            <span>基于你的知识库作答，超出范围会拒答，避免幻觉。</span>
          </div>
        </li>
      </ul>

      <p className={styles.foot}>超出范围会拒答 · 不预装通识百科</p>
    </section>
  );
}
