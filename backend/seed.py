"""Idempotent realistic demo data for the Docker runtime.

Usage inside the API container: ``python seed.py``. The runtime directory is a
D-drive bind mount in docker-compose, so database and file blobs never land on C.
"""
from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime, timedelta, timezone

from fhapi import config, db, security

R = random.Random(20260817)
USER_ID = "usr_filehub_demo"
EMAIL = "demo@filehub.local"
PASSWORD = "FileHubDemo123!"
WORKSPACES = [
    ("ws_seed_main", "产品研发知识中枢", 300),
    ("ws_seed_team", "团队交付资料库", 40),
    ("ws_seed_archive", "历史项目归档", 20),
]

TOPICS = [
    ("支付平台", "交易链路、清结算、退款与对账", "产品"),
    ("会员增长", "用户分层、权益体系、留存与召回", "运营"),
    ("数据治理", "指标口径、血缘追踪、质量监控", "数据"),
    ("智能客服", "意图识别、知识检索、人工转接", "AI"),
    ("供应链", "库存预测、采购协同、履约时效", "业务"),
    ("移动端体验", "首屏性能、交互一致性、无障碍", "设计"),
    ("安全合规", "权限审计、隐私保护、应急响应", "安全"),
    ("云原生平台", "容器编排、服务治理、可观测性", "研发"),
    ("内容社区", "推荐策略、审核流程、创作者激励", "产品"),
    ("国际化", "多语言、时区、税务与本地支付", "业务"),
    ("搜索平台", "索引构建、召回排序、查询分析", "研发"),
    ("财务数字化", "预算管理、成本核算、经营分析", "财务"),
]
KINDS = [
    ("需求规格", "PDF"), ("技术方案", "DOC"), ("会议纪要", "MD"),
    ("接口设计", "JSON"), ("数据字典", "CSV"), ("测试报告", "MD"),
    ("用户研究", "DOCX"), ("架构总览", "PNG"), ("运维手册", "MD"),
    ("复盘总结", "PDF"), ("迭代计划", "MD"), ("风险清单", "XLSX"),
]
TAGS = [
    "重要", "待评审", "已发布", "产品", "研发", "设计", "运营", "数据",
    "安全", "财务", "AI", "架构", "需求", "测试", "复盘", "规范",
    "客户反馈", "季度目标", "技术债", "决策记录", "高优先级", "跨团队", "合规", "归档",
]
COLORS = ["blue", "green", "orange", "red", "gray", "purple"]


def iso(days_ago: int, minutes: int = 0) -> str:
    value = datetime.now(timezone.utc) - timedelta(days=days_ago, minutes=minutes)
    return value.replace(microsecond=0).isoformat()


def content_for(i: int, topic: tuple[str, str, str], kind: tuple[str, str]) -> str:
    name, scope, owner = topic
    doc, _ = kind
    quarter = f"2026 Q{1 + i % 4}"
    return f"""# {name} - {doc}

## 背景
本资料沉淀 {quarter} {name} 项目的关键事实，覆盖{scope}。当前负责人为{owner}团队，参与方包括产品、研发、设计、测试与运营。

## 目标与指标
- 核心流程成功率达到 {96 + i % 4}.{i % 10}%
- 关键页面 P95 响应时间低于 {300 + (i % 5) * 100}ms
- 本季度完成 {3 + i % 8} 个里程碑并形成可审计记录

## 实施方案
1. 统一领域模型和接口契约，所有变更经过版本评审。
2. 建立灰度发布、监控告警和回滚机制，按周复盘异常。
3. 将关键决策关联到 [[{TOPICS[(i + 1) % len(TOPICS)][0]} - 技术方案]]，减少信息孤岛。

## 风险与行动项
- [ ] {iso(i % 30)[:10]} 前确认跨团队依赖和资源窗口
- [ ] 补齐边界场景测试，负责人：项目质量小组
- [x] 完成第一轮方案评审并记录结论

## 结论
方案具备分阶段上线条件。优先验证高风险链路，指标稳定后逐步扩大流量；所有资料通过 FileHub 标签、版本和关系图谱持续维护。
"""


def main() -> None:
    config.ensure_dirs()
    db.init_db()
    now = iso(0)
    with db.db() as c:
        existing = c.execute("SELECT id FROM users WHERE email=?", (EMAIL,)).fetchone()
        if existing and existing["id"] != USER_ID:
            user_id = existing["id"]
            c.execute("UPDATE users SET password_hash=?,display_name=? WHERE id=?",
                      (security.hash_password(PASSWORD), "FileHub 演示用户", user_id))
        else:
            user_id = USER_ID
            c.execute(
                "INSERT INTO users(id,email,password_hash,display_name,token_version,created_at) VALUES(?,?,?,?,0,?) "
                "ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,display_name=excluded.display_name",
                (user_id, EMAIL, security.hash_password(PASSWORD), "FileHub 演示用户", iso(180)),
            )

        ws_ids = [x[0] for x in WORKSPACES]
        c.executemany("DELETE FROM search_documents WHERE workspace_id=?", [(x,) for x in ws_ids])
        c.executemany("DELETE FROM workspaces WHERE id=?", [(x,) for x in ws_ids])
        c.execute("DELETE FROM templates WHERE user_id=? AND id LIKE 'tpl_seed_%'", (user_id,))
        c.execute("DELETE FROM notifications WHERE user_id=? AND id LIKE 'ntf_seed_%'", (user_id,))
        c.execute("DELETE FROM audit_log WHERE user_id=? AND id LIKE 'aud_seed_%'", (user_id,))

        for idx, (wid, name, _) in enumerate(WORKSPACES):
            c.execute("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
                      (wid, user_id, name, iso(150 - idx * 10), iso(idx)))

        tag_ids: dict[str, str] = {}
        for i, tag in enumerate(TAGS):
            c.execute("INSERT OR IGNORE INTO tags(id,user_id,name,color) VALUES(?,?,?,?)",
                      (f"tag_seed_{i:02d}", user_id, tag, COLORS[i % len(COLORS)]))
            tag_ids[tag] = c.execute("SELECT id FROM tags WHERE user_id=? AND name=?", (user_id, tag)).fetchone()["id"]

        all_by_ws: dict[str, list[str]] = {}
        global_i = 0
        for wid, _, count in WORKSPACES:
            ids: list[str] = []
            for local_i in range(count):
                i = global_i + local_i
                topic = TOPICS[i % len(TOPICS)]
                kind = KINDS[(i * 5 + i // len(TOPICS)) % len(KINDS)]
                title = f"{topic[0]} - {kind[0]} - {2024 + i % 3}{(i % 12) + 1:02d}"
                ext = kind[1].lower()
                name = f"{title}.{ext}"
                fid = f"file_seed_{i:04d}"
                ids.append(fid)
                text = content_for(i, topic, kind)
                folder = config.FILES_DIR / fid
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / name
                path.write_text(text, encoding="utf-8")
                stamp = iso(i % 120, i % 1440)
                summary = f"{topic[0]}{kind[0]}，聚焦{topic[1]}，包含目标指标、实施方案、风险与行动项。"
                c.execute(
                    "INSERT INTO files(id,workspace_id,user_id,name,type,path,mime,size,sha256,summary,content,x,y,favorite,deleted,deleted_at,version,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fid, wid, user_id, name, kind[1], str(path), "text/plain", len(text.encode()),
                     hashlib.sha256(text.encode()).hexdigest(), summary, text,
                     30 + (local_i % 8) * 98, 35 + ((local_i // 8) % 9) * 82,
                     int(i % 9 == 0), int(i % 47 == 0), iso(i % 20) if i % 47 == 0 else None,
                     3, iso(180 - i % 90), stamp),
                )
                c.execute("INSERT INTO search_documents(file_id,workspace_id,name,content) VALUES(?,?,?,?)", (fid, wid, name, text))
                for v in range(3):
                    c.execute("INSERT INTO file_versions(id,file_id,content,created_at) VALUES(?,?,?,?)",
                              (f"ver_seed_{i:04d}_{v}", fid, text + f"\n\n版本记录：第 {v + 1} 次评审。", iso(30 + v * 12 + i % 20)))
                selected = {TAGS[(i + x * 7) % len(TAGS)] for x in range(3)} | {topic[2]}
                for tag in selected:
                    if tag in tag_ids:
                        c.execute("INSERT OR IGNORE INTO file_tags(file_id,tag_id) VALUES(?,?)", (fid, tag_ids[tag]))
            all_by_ws[wid] = ids
            global_i += count

        for wid, ids in all_by_ws.items():
            for i, fid in enumerate(ids):
                for jump in (1, 7):
                    target = ids[(i + jump) % len(ids)]
                    a, b = (fid, target) if fid < target else (target, fid)
                    c.execute("INSERT OR IGNORE INTO connections(id,workspace_id,a_id,b_id,created_at) VALUES(?,?,?,?,?)",
                              (f"conn_seed_{wid}_{i}_{jump}", wid, a, b, iso(i % 90)))

            canvas_nodes = [{"id": fid, "x": 30 + (i % 8) * 98, "y": 35 + ((i // 8) % 9) * 82} for i, fid in enumerate(ids[:72])]
            canvas_links = [[ids[i], ids[(i + 1) % len(ids)]] for i in range(min(71, len(ids) - 1))]
            c.execute("INSERT INTO canvas_snapshots(id,workspace_id,revision,nodes,connections,viewport,created_at) VALUES(?,?,?,?,?,?,?)",
                      (f"snap_seed_{wid}", wid, 1, json.dumps(canvas_nodes), json.dumps(canvas_links), json.dumps({"x": 0, "y": 0, "zoom": 1}), now))
            c.execute("INSERT INTO canvas_pointer(workspace_id,current_revision) VALUES(?,1)", (wid,))
            for a in range(4):
                layout = {fid: {"x": 40 + (i % 7) * 110, "y": 50 + ((i // 7) % 7) * 95} for i, fid in enumerate(ids[:49])}
                c.execute("INSERT INTO anchors(id,workspace_id,name,layout,created_at) VALUES(?,?,?,?,?)",
                          (f"anchor_seed_{wid}_{a}", wid, ["产品评审", "研发规划", "风险复盘", "专注阅读"][a], json.dumps(layout), iso(a * 4)))
            for e in range(min(180, len(ids))):
                event_type = ["file.created", "file.updated", "canvas.saved", "comment.created", "link.created"][e % 5]
                c.execute("INSERT INTO timeline_events(id,workspace_id,event_type,payload,created_at) VALUES(?,?,?,?,?)",
                          (f"ev_seed_{wid}_{e:03d}", wid, event_type, json.dumps({"fileId": ids[e % len(ids)], "sequence": e}, ensure_ascii=False), iso(e % 120, e * 7)))

        main_ids = all_by_ws["ws_seed_main"]
        for i in range(120):
            stamp = iso(i % 60, i * 3)
            c.execute("INSERT INTO comments(id,file_id,user_id,text,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                      (f"comment_seed_{i:03d}", main_ids[i % len(main_ids)], user_id,
                       ["请补充验收数据与责任人。", "方案已评审，建议灰度后观察一周。", "这里与上季度口径不一致，请确认。", "已同步相关团队，等待排期确认。"][i % 4], stamp, stamp))
        for i in range(80):
            c.execute("INSERT INTO notifications(id,user_id,text,unread,created_at) VALUES(?,?,?,?,?)",
                      (f"ntf_seed_{i:03d}", user_id,
                       ["AI 已完成文档摘要", "新的批注等待处理", "画布备份已完成", "重复资料扫描发现候选项"][i % 4], int(i < 12), iso(i % 45, i * 9)))
        for i in range(6):
            payload = {"nodes": [{"name": n, "type": "MD"} for n in ["目标", "范围", "里程碑", "风险"]], "links": [[0, 1], [1, 2], [2, 3]]}
            c.execute("INSERT INTO templates(id,user_id,name,description,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                      (f"tpl_seed_{i}", user_id, ["项目启动", "用户研究", "技术评审", "季度复盘", "故障复盘", "读书笔记"][i], "可直接应用的结构化画布模板", json.dumps(payload, ensure_ascii=False), iso(90), now))
        for i in range(15):
            c.execute("INSERT INTO dedup_pairs(id,workspace_id,a_id,b_id,similarity,status) VALUES(?,?,?,?,?,?)",
                      (f"dedup_seed_{i:02d}", "ws_seed_main", main_ids[i], main_ids[i + 12], 82 + i % 15, "open"))
        for i in range(10):
            c.execute("INSERT INTO shares(id,file_id,user_id,token,expires_at,permission,created_at) VALUES(?,?,?,?,?,?,?)",
                      (f"share_seed_{i:02d}", main_ids[i], user_id, f"filehub-demo-share-{i:02d}", iso(-30), "edit" if i % 3 == 0 else "read", iso(i)))
        for i in range(100):
            c.execute("INSERT INTO audit_log(id,user_id,action,resource,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)",
                      (f"aud_seed_{i:03d}", user_id, ["file.view", "file.update", "search.query", "canvas.save"][i % 4], main_ids[i % len(main_ids)], "seeded realistic activity", "127.0.0.1", iso(i % 60)))

    print(json.dumps({"user": EMAIL, "workspaces": len(WORKSPACES), "files": sum(x[2] for x in WORKSPACES), "runtime": str(config.ROOT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
