# ATLAS Agent Data QA — Offer Draft (Internal Only)

**Status:** DRAFT — DO NOT SEND, PUBLISH, OR ACCEPT ORDERS FOR THE PROPOSED SCHEMA-CHECK ADD-ON.  
**Prepared:** 2026-10-13  
**Product record currently in production:** `atlas_ai_data_qa_v1` — ACTIVE base service at 15 USDC per dataset. This draft does not change that record.

## Short English offer (proposed copy)

**ATLAS Data QA for Agent Workflows**

Before an agent passes a CSV into its next tool or workflow, ATLAS can help verify that the dataset matches an explicit contract.

**Proposed schema-check workflow (not yet available):**
- Input: one CSV (up to 5,000 rows) plus a JSON contract describing required columns and basic data types.
- Output: a deterministic PASS/FAIL result and a machine-readable JSON issue report identifying row/column/rule problems.
- Invalid values are reported rather than silently coerced. The default report does not include raw cell values.
- Designed as a focused validation step before downstream ingestion—not as a replacement for a full data-quality platform.

**Availability:** The schema-check add-on is a proposal only and is not currently offered.  
**Current base service:** ATLAS already lists CSV/XLSX cleaning and QA for one dataset up to 5,000 rows at **15 USDC per dataset**, subject to the existing founder-controlled quote/payment flow. That price does not include the proposed schema-check feature.  
**Pricing for the proposed add-on:** Not set. A founder-approved quote is required before any commercial commitment.

## Short Arabic internal version

**فحص جودة البيانات قبل تسليمها إلى وكيل آخر — مقترح من أطلس**

يرسل الوكيل ملف CSV وعقدًا يحدد الأعمدة المطلوبة وأنواع البيانات. يعيد أطلس نتيجة واضحة `PASS/FAIL` وتقرير JSON قابلًا للقراءة آليًا يوضح رقم الصف والعمود وقاعدة التحقق التي فشلت، من دون تعديل القيم غير الصحيحة بصمت.

هذه الإضافة **غير متاحة حاليًا وليست معروضة للبيع**. الخدمة الأساسية الحالية لتنظيف CSV/XLSX حتى 5,000 صف مسجلة بسعر 15 USDC لكل مجموعة بيانات؛ هذا السعر لا يشمل إضافة التحقق المقترحة، وسعرها لم يُحدد.

## Discovery questions (ask only after founder approval)

1. Which downstream step fails when your agent receives a CSV that does not match its expected schema?
2. How often did this occur in the last 30 days, and what did it cost in retries, tool calls, or manual repair?
3. What validator or library do you use now (e.g. Ajv, Pydantic, Soda, Great Expectations), and what is missing?
4. Would a deterministic JSON PASS/FAIL report be enough, or must ATLAS block an actual handoff?
5. Would you run a pilot with synthetic data first? What measurable result would justify paying?

## Rules

- This message has not been sent to any person, agent, marketplace, or mailing list.
- No claims of customers, revenue, performance, or availability.
- No free pilot, discount, price, SLA, support commitment, or deployment promise is authorized here.
- Do not publish or send this draft without founder approval.
