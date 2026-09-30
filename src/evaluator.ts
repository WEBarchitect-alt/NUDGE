export type EvaluationCompletion = 'completed' | 'partial' | 'not_completed' | 'unclear';

export interface EvaluationResult {
  completion: EvaluationCompletion;
  confidence: number;
  evidence: string[];
  gaps: string[];
  assessment: string;
  nextAction: string;
}

export interface EvaluateCheckInParams {
  apiKey: string;
  commitmentTitle: string;
  commitmentContext?: string;
  spokenAnswer: string;
}

const EVALUATION_PROMPT = `You are the strict, objective AI evaluator for Nudge, an accountability application.
Your role is to assess whether a user legitimately completed their promised commitment based on their spoken defense.

GUIDELINES:
1. Distinguish actual concrete evidence of work from vague affirmations (e.g., "I worked hard", "I finished it all").
2. Look for technical specifics, tangible artifacts, problem-solving details, or concepts learned.
3. If an answer lacks concrete details, classify it as "partial" or "unclear", rather than assuming completion.
4. If the defense demonstrates clear fabrication or evasiveness, classify as "not_completed".
5. Never invent or hallucinate evidence that the user did not explicitly mention.
6. Remain professional, rigorous, and direct. Never use derogatory, humiliating, or abusive language.
7. Judge strictly against the specific commitment title and syllabus/topics provided.`;

const EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    completion: {
      type: 'string',
      enum: ['completed', 'partial', 'not_completed', 'unclear'],
    },
    confidence: {
      type: 'number',
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
    },
    gaps: {
      type: 'array',
      items: { type: 'string' },
    },
    assessment: {
      type: 'string',
    },
    nextAction: {
      type: 'string',
    },
  },
  required: ['completion', 'confidence', 'evidence', 'gaps', 'assessment', 'nextAction'],
};

export async function evaluateCheckIn({
  apiKey,
  commitmentTitle,
  commitmentContext,
  spokenAnswer,
}: EvaluateCheckInParams): Promise<EvaluationResult> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('Missing Gemini API Key. Please add your API key in Settings.');
  }

  const cleanAnswer = spokenAnswer.trim();
  if (!cleanAnswer) {
    throw new Error('No verbal defense provided to evaluate.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${cleanKey}`;

  const payload = {
    model: 'gemini-3.6-flash',
    system_instruction: EVALUATION_PROMPT,
    input: `TARGET COMMITMENT:
Title: ${commitmentTitle}
Expected Context / Topics: ${commitmentContext || 'None provided'}

USER'S SPOKEN DEFENSE:
"${cleanAnswer}"`,
    generation_config: {
      temperature: 0.1,
    },
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: EVALUATION_JSON_SCHEMA,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) {
        errorDetail = errJson.error.message;
      }
    } catch {
      // Fall back to status code
    }
    throw new Error(errorDetail);
  }

  const data = await response.json();

  // Extract from step-based API format
  const textPart = data.steps
    ?.filter((step: any) => step?.type === 'model_output')
    .flatMap((step: any) => step?.content || [])
    .find((content: any) => content?.type === 'text' && content?.text);

  let rawJsonText = textPart?.text || '';

  // Fallbacks for legacy/alternative formats
  if (!rawJsonText) {
    if (typeof data?.output === 'string') {
      rawJsonText = data.output;
    } else if (Array.isArray(data?.outputs)) {
      const fallbackPart = data.outputs
        .flatMap((out: { content?: Array<{ type?: string; text?: string }> }) => out?.content || [])
        .find((c: { type?: string; text?: string }) => c?.type === 'text' && c?.text);
      rawJsonText = fallbackPart?.text || '';
    } else if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      rawJsonText = data.candidates[0].content.parts[0].text;
    }
  }

  if (!rawJsonText) {
    throw new Error('Interactions API did not return text in the response output.');
  }

  try {
    const parsed = JSON.parse(rawJsonText) as EvaluationResult;

    if (
      !['completed', 'partial', 'not_completed', 'unclear'].includes(parsed.completion) ||
      typeof parsed.confidence !== 'number' ||
      !Array.isArray(parsed.evidence) ||
      !Array.isArray(parsed.gaps) ||
      typeof parsed.assessment !== 'string' ||
      typeof parsed.nextAction !== 'string'
    ) {
      throw new Error('Evaluation output does not conform to the expected schema.');
    }

    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse evaluation output: ${(err as Error).message}`);
  }
}