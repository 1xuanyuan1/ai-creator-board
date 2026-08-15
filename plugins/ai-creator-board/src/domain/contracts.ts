export const candidateBatchOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["date", "candidates", "sourceErrors"],
  properties: {
    date: { type: "string" },
    sourceErrors: { type: "array", items: { type: "string" } },
    candidates: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "occurredAt", "freshness", "factStatus", "whyNow", "tension", "concept", "viewpoints", "audience", "primarySources", "crossSources", "score", "tags"],
        properties: {
          topic: { type: "string" },
          occurredAt: { type: "string" },
          freshness: { type: "string" },
          factStatus: { type: "string" },
          whyNow: { type: "string" },
          tension: { type: "string" },
          concept: { type: "string" },
          viewpoints: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "statement", "rationale"],
              properties: {
                key: { type: "string", enum: ["A", "B", "C"] },
                statement: { type: "string" },
                rationale: { type: "string" }
              }
            }
          },
          audience: { type: "string" },
          primarySources: { type: "array", items: { $ref: "#/$defs/source" } },
          crossSources: { type: "array", items: { $ref: "#/$defs/source" } },
          score: {
            type: "object",
            additionalProperties: false,
            required: ["importance", "evidence", "concept", "audience", "visuals"],
            properties: {
              importance: { type: "number" },
              evidence: { type: "number" },
              concept: { type: "number" },
              audience: { type: "number" },
              visuals: { type: "number" }
            }
          },
          tags: { type: "array", items: { type: "string" } }
        }
      }
    }
  },
  $defs: {
    source: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        title: { type: "string" },
        url: { type: "string" },
        tier: { type: "string", enum: ["T1-primary", "T2-secondary", "T3-community"] }
      }
    }
  }
} as const;

export const stageOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "nextStage", "artifacts", "reviews", "needsDecision"],
  properties: {
    summary: { type: "string" },
    nextStage: { type: "string", enum: ["research", "title_cover", "production", "review", "finalize"] },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "path", "mimeType"],
        properties: {
          type: { type: "string", enum: ["research-card", "fact-ledger", "script", "storyboard", "publishing-metadata", "cover-horizontal", "cover-vertical", "review-report", "source-appendix", "manifest"] },
          name: { type: "string" },
          path: { type: "string" },
          mimeType: { type: "string" },
          platform: { type: "string", enum: ["bilibili", "douyin", "shipinhao", "xiaohongshu"] },
          reviewStatus: { type: "string", enum: ["PASS", "FAIL"] }
        }
      }
    },
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["platform", "status", "failures", "suggestions"],
        properties: {
          platform: { type: "string", enum: ["bilibili", "douyin", "shipinhao", "xiaohongshu"] },
          status: { type: "string", enum: ["PASS", "FAIL"] },
          failures: { type: "array", items: { type: "string" } },
          suggestions: { type: "array", items: { type: "string" } }
        }
      }
    },
    needsDecision: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "question", "options", "context"],
          properties: {
            kind: { type: "string", enum: ["TITLE_COVER", "SENSITIVE_TOPIC", "EVIDENCE_CONFLICT", "REVIEW_FAILED", "CONFIGURATION"] },
            question: { type: "string" },
            context: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "description"],
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" }
                }
              }
            }
          }
        }
      ]
    }
  }
} as const;
