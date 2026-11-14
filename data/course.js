/* Shared course data. Each data/weekNN.js file adds one week to COURSE.weeks.

   Lesson format:
     title    short name of the lesson
     can      finishes the sentence "I can ..." / "After today you can ..."
     tip      one short pattern or pronunciation note
     phrases  [Spanish, English, optional note]   -> become spaced-repetition cards
     who      optional [name of speaker A, name of speaker B]; B is the learner
     dialogue [speaker 'A' or 'B', Spanish, English]
     build    [English prompt, Spanish answer]    -> new sentences from known pieces
     say      the one-minute free-talk task
*/
window.COURSE = {
  weeks: [],

  // Day 1 primer: [letter, example words (spoken), how it sounds]
  sounds: [
    ['a', 'casa, mañana, gracias', 'Always "ah", as in "father".'],
    ['e', 'mesa, café, tres', 'Always "eh", as in "met".'],
    ['i', 'sí, amigo, día', 'Always "ee", as in "see".'],
    ['o', 'hola, ocho, como', 'Always a short, pure "oh".'],
    ['u', 'uno, tú, mucho', 'Always "oo", as in "food".'],
    ['h', 'hola, hotel, hay', 'Always silent.'],
    ['ñ', 'mañana, español, año', 'Like "ny" in "canyon".'],
    ['ll', 'me llamo, calle, pollo', 'Like "y" in "yes".'],
    ['j', 'jugo, trabajo, hijo', 'A strong "h" from the throat.'],
    ['r', 'pero, tres, gracias', 'One quick tap of the tongue, like the "tt" in the American "better".'],
  ],
};
