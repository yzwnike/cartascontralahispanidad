export type CunadometroMode = 'duel' | 'all_play';

export const cunadometroPrompts: Record<CunadometroMode, string[]> = {
  duel: [
    'Tu colega acaba de decir «yo controlo» y va directo a liarla. ¿Cuál sería el titular de mañana?',
    'Inventa el peor nombre posible para una urbanización de lujo en mitad de la nada.',
    '¿Qué frase pondrías en una taza para alguien que siempre llega tarde?',
    'La nueva asignatura obligatoria del instituto se llama «___ para sobrevivir a una comida familiar».',
    '¿Cuál es el nombre de una banda tributo que solo toca canciones de ascensor?',
    'Describe en una frase la peor app que alguien podría presentar como una idea millonaria.',
    'Tu grupo de WhatsApp se convierte en una serie. ¿Cómo se llama el primer capítulo?',
    '¿Qué servicio absurdo abriría alguien para hacerse rico en un pueblo de 300 habitantes?',
    'El nuevo perfume de moda huele a ___. ¿Cómo se llama?',
    '¿Cuál sería el lema de un gimnasio donde todo el mundo evita hacer ejercicio?',
    'Escribe el aviso que encontrarías en la puerta de una casa encantada muy española.',
    '¿Qué nombre le pondrías a una consultora especializada en dar consejos que nadie pidió?',
  ],
  all_play: [
    '¿Qué significan las siglas RGP? La respuesta más convincente gana.',
    'Inventa un insulto cariñoso que incluya la palabra «jamón».',
    'Completa el mensaje de voz: «No te vas a creer lo que acaba de pasar en el súper…».',
    'Inventa una nueva tradición para celebrar que por fin se cancela un plan.',
    '¿Qué pondría en su perfil una persona que presume de saber aparcar pero no sabe?',
    'Crea el nombre de una tapa que solo servirían después de cerrar la cocina.',
    'Escribe una excusa para llegar tarde que empiece con «técnicamente…».',
    '¿Qué premio recibiría alguien por mandar «voy saliendo» sin haberse duchado?',
    'Inventa un refrán para cuando el grupo pide comida y nadie sabe qué quiere.',
    '¿Qué frase debería aparecer en el manual de instrucciones de una suegra moderna?',
    'Dale un significado nuevo y sospechoso a las siglas «VIP».',
    'Crea el eslogan de una academia para aprender a decir «no» a otro plan.',
  ],
};
