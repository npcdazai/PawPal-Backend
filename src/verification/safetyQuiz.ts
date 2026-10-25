/** Gate 1: five practical dog-handling scenarios; 4 of 5 to pass. Answers stay on the server. */

export const PASS_SCORE = 4;

interface Question {
  id: string;
  topic: string;
  prompt: string;
  options: { id: string; text: string }[];
  answer: string;
  /** Shown after a wrong answer, so a failed attempt still teaches. */
  explanation: string;
}

export const SAFETY_QUIZ: readonly Question[] = [
  {
    id: 'harness-fit',
    topic: 'Martingale & chest harness fitting',
    prompt: 'You’re fitting a chest harness on a Labrador before a walk. How do you know the fit is safe?',
    options: [
      { id: 'a', text: 'It’s as tight as possible so the dog can’t back out of it' },
      { id: 'b', text: 'Two fingers slide under every strap, and the chest strap sits behind the front legs without rubbing the armpits' },
      { id: 'c', text: 'It hangs loosely so the dog is comfortable' },
      { id: 'd', text: 'The leash is clipped to the collar as well, so fit doesn’t matter' },
    ],
    answer: 'b',
    explanation: 'The two-finger rule: snug enough that the dog can’t slip out, loose enough not to chafe or restrict breathing.',
  },
  {
    id: 'reactive-body-language',
    topic: 'Reactive dog body language',
    prompt: 'Halfway through a walk, the dog goes stiff, stares hard at another dog and its hackles rise. What do you do?',
    options: [
      { id: 'a', text: 'Let them sniff each other so they can settle it' },
      { id: 'b', text: 'Pull the leash tight and scold the dog' },
      { id: 'c', text: 'Calmly turn and walk away to put distance between them, keeping the leash short but not tense' },
      { id: 'd', text: 'Pick the dog up' },
    ],
    answer: 'c',
    explanation: 'Stiffness, a hard stare and raised hackles mean the dog is over threshold. Distance is the fix; tension on the leash and scolding escalate it.',
  },
  {
    id: 'stray-encounter',
    topic: 'Stray dog encounter protocol',
    prompt: 'A group of street dogs approaches, barking, while you walk your client’s dog. What’s the right response?',
    options: [
      { id: 'a', text: 'Run with the client’s dog to get away quickly' },
      { id: 'b', text: 'Stay calm, don’t make eye contact, keep your body between the strays and your dog, and walk away slowly; stop and stand still if they close in' },
      { id: 'c', text: 'Unclip the leash so your dog can defend itself' },
      { id: 'd', text: 'Throw stones to scare them off' },
    ],
    answer: 'b',
    explanation: 'Running triggers a chase and unclipping loses the dog. Calm, slow retreat with your body as a shield de-escalates; report the location to the app afterwards.',
  },
  {
    id: 'pavement-heat',
    topic: 'Pavement heat check',
    prompt: 'It’s 1 PM in May. How do you decide whether the pavement is safe for paws?',
    options: [
      { id: 'a', text: 'Press the back of your hand on it for 7 seconds; if you can’t hold it there, it’s too hot, so walk on grass or shade or reschedule' },
      { id: 'b', text: 'Dogs’ paws are tough, so any pavement is fine' },
      { id: 'c', text: 'Only check if the dog starts limping' },
      { id: 'd', text: 'Walk faster so the paws touch the ground less' },
    ],
    answer: 'a',
    explanation: 'Asphalt can be 20–30 °C hotter than the air and burn pads in under a minute. The 7-second hand test catches it before the dog is hurt.',
  },
  {
    id: 'doorstep-handover',
    topic: 'Doorstep leash handover',
    prompt: 'You arrive to pick up a dog. What’s the safe handover sequence?',
    options: [
      { id: 'a', text: 'Ask the owner to open the door and let the dog run out to you' },
      { id: 'b', text: 'Take the leash, then check the collar later on the walk' },
      { id: 'c', text: 'Clip your leash on and check the collar or harness while the owner still holds the dog, confirm the pickup OTP, and only then take over' },
      { id: 'd', text: 'Skip the OTP if the owner is in a hurry' },
    ],
    answer: 'c',
    explanation: 'Most escapes happen at the door. Two hands on the dog until your leash is secure, and the OTP starts the walk’s insurance cover.',
  },
];

/** Questions as the app sees them: no answers. */
export const publicQuiz = () =>
  SAFETY_QUIZ.map(({ id, topic, prompt, options }) => ({ id, topic, prompt, options }));

export function gradeQuiz(answers: Record<string, string>) {
  const review = SAFETY_QUIZ.map((question) => {
    const correct = answers[question.id] === question.answer;
    return { id: question.id, correct, ...(correct ? {} : { explanation: question.explanation }) };
  });
  const score = review.filter((entry) => entry.correct).length;
  return { score, total: SAFETY_QUIZ.length, passed: score >= PASS_SCORE, review };
}
