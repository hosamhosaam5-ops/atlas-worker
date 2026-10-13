# ATLAS Agent Contract Gate — Internal Offer Draft

**STATUS: INTERNAL HYPOTHESIS ONLY — NOT AVAILABLE, DO NOT SEND OR PUBLISH.**  
**Prepared:** 2026-10-13  
**Implementation:** Isolated, unintegrated prototype on `proposal/agent-data-qa-mvp-2026-10`.

## Draft English description

**ATLAS Agent Contract Gate (proposed)**

A small deterministic check at an agent/tool handoff. Give ATLAS serialized JSON and a declared schema from the supported subset; receive a machine-readable `PASS` or `FAIL` plus stable issue codes and JSON Pointer paths that help the caller locate a missing field or type mismatch.

The prototype is designed to fail closed on unsupported schema features, avoid coercing values, bound input and error counts, and avoid including raw payload values in its report. It is not a full JSON Schema validator, does not dereference remote schemas, and does not yet sit on a production request path.

**Availability:** Not currently offered. Internal prototype only.  
**Price:** Not set. No pilot or commercial commitment has been authorized.  
**Existing product:** ATLAS separately lists CSV/XLSX cleaning and QA up to 5,000 rows for 15 USDC per dataset; that current offer is unchanged and does not include this proposed capability.

## مسودة عربية داخلية

**بوابة أطلس للتحقق من عقد البيانات بين الوكلاء — مقترح فقط**

يرسل النظام JSON وعقدًا يحدد نوع البيانات والحقول المطلوبة. تعيد الأداة نتيجة `PASS/FAIL` وتقريرًا آليًا يحدد موضع المشكلة ورمزها، مثل حقل مطلوب مفقود أو نوع غير مطابق. لا تقوم الأداة بتعديل القيم بصمت، وترفض خصائص المخطط غير المدعومة بدلًا من تجاهلها.

هذه **نسخة أولية داخلية فقط** وليست خدمة جاهزة للبيع. التنفيذ الحالي لا يدعم معيار JSON Schema كاملًا، ولم يُدمج في مسار إنتاج أطلس. لم يُحدد السعر ولم يُعتمد أي اختبار تجاري أو التزام تجاه عميل.

## Questions for founder-approved design partners only

1. Describe one recent case where invalid JSON or a schema mismatch broke an agent/tool handoff.
2. Where should validation happen: immediately before handoff, immediately after tool output, or at both boundaries?
3. Which schema system and validator are already used (Ajv, Pydantic, Zod, framework-native, or another)?
4. What happens on failure now: retry, manual repair, task failure, or silent bad data?
5. What measurable improvement would justify adding another validation step?
6. Would the team run a synthetic prototype first, and what evidence would be needed before a paid pilot?

## Rules

- No message has been sent to any agent, person, marketplace, or mailing list.
- No external pilot, discount, SLA, support commitment, or price is offered.
- Do not imply the prototype is compliant with full JSON Schema or that a PASS guarantees downstream business correctness.
- Do not send this draft or expose the prototype publicly without founder approval.
