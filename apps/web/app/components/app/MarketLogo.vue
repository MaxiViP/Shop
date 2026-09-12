<template>
  <div class="market-logo">
    <svg
      class="market-logo__svg"
      viewBox="0 0 410 96"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient :id="strokeId" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f4d18e" />
          <stop offset="48%" stop-color="#c88a37" />
          <stop offset="100%" stop-color="#87551f" />
        </linearGradient>
        <linearGradient :id="fillId" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#f5ddb0" />
          <stop offset="100%" stop-color="#bf7f34" />
        </linearGradient>
      </defs>
      <g class="market-logo__icon" transform="translate(4 4)">
        <g class="market-logo__scene">
          <path
            class="market-logo__basket-draw"
            pathLength="1"
            d="M18 42 C23 12 72 7 84 40"
            fill="none"
            :stroke="`url(#${strokeId})`"
            stroke-width="5"
            stroke-linecap="round"
          />
          <path
            class="market-logo__basket-draw"
            pathLength="1"
            d="M8 43 H94 L87 76 C86 83 81 87 74 87 H29 C22 87 17 83 16 76 Z"
            :fill="`url(#${fillId})`"
            :stroke="`url(#${strokeId})`"
            stroke-width="3.5"
            stroke-linejoin="round"
          />
          <g class="market-logo__weave">
            <path
              d="M23 45 L23 84 M38 44 L38 86 M53 44 L53 86 M68 44 L68 85 M83 44 L83 80 M13 55 H91 M12 66 H89 M16 77 H86"
            />
          </g>
          <!-- Static placement stays on the outer group; CSS animates only the inner group. -->
          <g transform="translate(24 27)">
            <g class="market-logo__fruit market-logo__fruit--apple">
              <g class="market-logo__fruit-idle">
                <circle cx="13" cy="17" r="12" fill="#ef4444" />
                <circle
                  cx="9"
                  cy="13"
                  r="2.5"
                  fill="white"
                  fill-opacity=".28"
                />
                <path
                  d="M14 7 C13 2 17 0 20 3"
                  fill="none"
                  stroke="#654321"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <path
                  d="M19 5 C25 1 29 4 28 9 C24 9 21 8 19 5 Z"
                  fill="#43a047"
                />
              </g>
            </g>
          </g>
          <g transform="translate(42 20)">
            <g class="market-logo__fruit market-logo__fruit--orange">
              <g class="market-logo__fruit-idle">
                <circle cx="14" cy="18" r="13" fill="#fb8c00" />
                <circle
                  cx="10"
                  cy="14"
                  r="2.5"
                  fill="white"
                  fill-opacity=".25"
                />
                <path
                  d="M14 5 C14 1 18 0 20 2"
                  fill="none"
                  stroke="#654321"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </g>
            </g>
          </g>
          <g transform="translate(59 21)">
            <g class="market-logo__fruit market-logo__fruit--pear">
              <g class="market-logo__fruit-idle">
                <path
                  d="M12 4 C7 4 5 10 7 15 C8 19 4 22 4 28 C4 37 10 42 18 42 C26 42 32 37 32 28 C32 22 28 19 29 14 C30 9 26 4 21 4 C20 1 22 0 24 0"
                  fill="#a8c93e"
                />
                <path
                  d="M21 4 C21 1 23 0 25 1"
                  fill="none"
                  stroke="#654321"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <ellipse
                  cx="27"
                  cy="5"
                  rx="5"
                  ry="2.5"
                  fill="#4caf50"
                  transform="rotate(-20 27 5)"
                />
              </g>
            </g>
          </g>
          <g transform="translate(71 35)">
            <g class="market-logo__fruit market-logo__fruit--grapes">
              <g class="market-logo__fruit-idle">
                <circle cx="5" cy="5" r="4.5" fill="#7e3fa3" />
                <circle cx="12" cy="5" r="4.5" fill="#8e44ad" />
                <circle cx="2" cy="12" r="4.5" fill="#79409a" />
                <circle cx="9" cy="12" r="4.5" fill="#9148b3" />
                <circle cx="16" cy="12" r="4.5" fill="#774094" />
                <circle cx="6" cy="19" r="4.5" fill="#8745a8" />
                <circle cx="13" cy="19" r="4.5" fill="#754091" />
                <path
                  d="M9 0 C10 -4 14 -4 16 -1"
                  fill="none"
                  stroke="#654321"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </g>
            </g>
          </g>
        </g>
      </g>
      <g class="market-logo__wordmark">
        <text
          x="114"
          y="61"
          textLength="282"
          lengthAdjust="spacingAndGlyphs"
          class="market-logo__text"
        >
          <tspan class="market-logo__text--korzina">Korzina</tspan>
          <tspan class="market-logo__text--market">Market</tspan>
        </text>
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
const id = useId();
const strokeId = `${id}-basket-stroke`;
const fillId = `${id}-basket-fill`;
</script>

<style scoped>
.market-logo {
  display: flex;
  align-items: center;
  width: 48px;
  height: 44px;
  overflow: hidden;
}
.market-logo__svg {
  display: block;
  flex: none;
  width: 188px;
  height: 44px;
}
.market-logo__basket-draw {
  opacity: 0;
  animation: market-logo-show 0.8s ease forwards;
}
.market-logo__weave {
  fill: none;
  stroke: rgba(112, 67, 21, 0.34);
  stroke-width: 1.4;
  stroke-linecap: round;
  opacity: 0;
  animation: market-logo-show 0.7s 0.8s ease forwards;
}
.market-logo__scene,
.market-logo__fruit,
.market-logo__fruit-idle {
  transform-box: fill-box;
  transform-origin: center bottom;
}
.market-logo__scene {
  animation:
    market-logo-settle 0.5s 4.7s ease-in-out,
    market-logo-idle 8s 5.2s ease-in-out infinite;
}
.market-logo__fruit {
  opacity: 0;
  animation: market-logo-fruit-in 0.8s var(--fruit-delay)
    cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
}
.market-logo__fruit-idle {
  animation:
    market-logo-fruit-settle 0.5s 4.7s ease-in-out,
    market-logo-fruit-idle 8s 5.2s ease-in-out infinite;
}
.market-logo__fruit--apple {
  --fruit-delay: 1.5s;
  --fruit-angle: -6deg;
  --fruit-hop: -1.5px;
  --fruit-tilt: -2deg;
}
.market-logo__fruit--orange {
  --fruit-delay: 2.3s;
  --fruit-angle: 5deg;
  --fruit-hop: -1px;
  --fruit-tilt: 1.5deg;
}
.market-logo__fruit--pear {
  --fruit-delay: 3.1s;
  --fruit-angle: -4deg;
  --fruit-hop: -2px;
  --fruit-tilt: 1deg;
}
.market-logo__fruit--grapes {
  --fruit-delay: 3.9s;
  --fruit-angle: 6deg;
  --fruit-hop: -1px;
  --fruit-tilt: -2deg;
}
.market-logo__wordmark {
  display: none;
  opacity: 0;
  animation: market-logo-show 0.4s 0.8s ease forwards;
}
.market-logo__text {
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: 38px;
  font-weight: 750;
  letter-spacing: -1.5px;
}
.market-logo__text--korzina {
  fill: var(--ui-success);
}
.market-logo__text--market {
  fill: var(--ui-text);
}
@keyframes market-logo-show {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes market-logo-fruit-in {
  0% {
    opacity: 0;
    transform: translateY(-18px) scale(0.8) rotate(var(--fruit-angle));
  }
  35% {
    opacity: 1;
  }
  78% {
    opacity: 1;
    transform: translateY(2px) scale(1.04) rotate(0deg);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1) rotate(0deg);
  }
}
@keyframes market-logo-settle {
  0%,
  100% {
    transform: rotate(0deg);
  }
  30% {
    transform: rotate(-1deg);
  }
  65% {
    transform: rotate(1deg);
  }
}
/* 7.3 seconds still, followed by a 0.7 second gesture. */
@keyframes market-logo-idle {
  0%,
  91.25%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  94% {
    transform: translateY(-1px) rotate(-1deg);
  }
  96.5% {
    transform: translateY(0) rotate(1deg);
  }
  98.5% {
    transform: translateY(0) rotate(-0.5deg);
  }
}
@keyframes market-logo-fruit-settle {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  40% {
    transform: translateY(var(--fruit-hop)) rotate(var(--fruit-tilt));
  }
}
@keyframes market-logo-fruit-idle {
  0%,
  91.25%,
  100% {
    transform: translateY(0) rotate(0deg);
  }
  95% {
    transform: translateY(var(--fruit-hop)) rotate(var(--fruit-tilt));
  }
  98% {
    transform: translateY(0.5px) rotate(0deg);
  }
}
@media (min-width: 64rem) {
  .market-logo {
    width: 188px;
  }
  .market-logo__wordmark {
    display: inline;
  }
}
@media (prefers-reduced-motion: reduce) {
  .market-logo__basket-draw,
  .market-logo__weave,
  .market-logo__scene,
  .market-logo__fruit-idle,
  .market-logo__fruit,
  .market-logo__wordmark {
    animation: none !important;
    transition: none !important;
    opacity: 1;
  }
  .market-logo__scene,
  .market-logo__fruit-idle,
  .market-logo__fruit {
    transform: none;
  }
}
</style>
