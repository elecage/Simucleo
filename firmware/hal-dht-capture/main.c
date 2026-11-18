/*
 * CubeMX-style HAL example: a DHT22 read with timer input capture.
 *
 *   D3 (PB3, TIM2_CH2)  DATA of a DHT22 module (3V3, GND; the module has a
 *                       10 kΩ pull-up on DATA)
 *
 * The start signal is sent with the pin as an open-drain GPIO output held
 * low for 20 ms (enough for a DHT11 as well). Then the pin is handed to
 * TIM2 channel 2, which captures every edge (both polarities) with a
 * 1 µs time base, in its interrupt. A bit is the length of the high pulse
 * after each 50 µs low: about 27 µs for a 0, 70 µs for a 1.
 *
 * Every 2 s the reading is printed; B1 prints the raw pulse widths.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2;

static volatile uint32_t edges[96];
static volatile int n_edges;

static void MX_GPIO_Init(void);
static void MX_TIM2_Init(void);
static void MX_USART2_UART_Init(void);

static void data_pin(uint32_t mode)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  GPIO_InitStruct.Pin = GPIO_PIN_3;
  GPIO_InitStruct.Mode = mode;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  GPIO_InitStruct.Alternate = GPIO_AF1_TIM2;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
}

void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2 && htim->Channel == HAL_TIM_ACTIVE_CHANNEL_2 && n_edges < 96)
  {
    edges[n_edges++] = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_2);
  }
}

void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

/* Returns 0 and the bytes, or a negative error. */
static int dht_read(uint8_t data[5], int verbose)
{
  /* Start: hold the line low, then release it to the capture input. */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_3, GPIO_PIN_RESET);
  data_pin(GPIO_MODE_OUTPUT_OD);
  HAL_Delay(20);
  n_edges = 0;
  HAL_TIM_IC_Start_IT(&htim2, TIM_CHANNEL_2);
  data_pin(GPIO_MODE_AF_OD); /* released: the pull-up raises the line */
  HAL_Delay(8);              /* the answer takes about 5 ms */
  HAL_TIM_IC_Stop_IT(&htim2, TIM_CHANNEL_2);

  int n = n_edges;
  if (n < 82)
  {
    return -1; /* no (complete) answer */
  }
  /* From the end: the last edge is the final release; before it come 40
     (rising, falling) pairs, one per bit. */
  for (int i = 0; i < 5; i++)
  {
    data[i] = 0;
  }
  for (int bit = 0; bit < 40; bit++)
  {
    int fall = n - 2 - 2 * (39 - bit);
    uint32_t high = edges[fall] - edges[fall - 1];
    if (verbose)
    {
      printf("%lu%s", (unsigned long)high, bit % 8 == 7 ? "\r\n" : " ");
    }
    data[bit / 8] = (uint8_t)(data[bit / 8] << 1 | (high > 48));
  }
  if ((uint8_t)(data[0] + data[1] + data[2] + data[3]) != data[4])
  {
    return -2;
  }
  return 0;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_TIM2_Init();
  MX_USART2_UART_Init();
  printf("DHT22 on D3: TIM2_CH2 input capture, both edges, 1 us\r\n");
  HAL_Delay(1000); /* the sensor needs a second after power-up */

  while (1)
  {
    int verbose = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET;
    uint8_t d[5];
    int r = dht_read(d, verbose);
    if (r == -1)
    {
      printf("no answer from the sensor (%d edges)\r\n", n_edges);
    }
    else if (r == -2)
    {
      printf("checksum error\r\n");
    }
    else
    {
      int h10 = d[0] << 8 | d[1];
      int t10 = (d[2] & 0x7F) << 8 | d[3];
      if (d[2] & 0x80)
      {
        t10 = -t10;
      }
      printf("humidity %d.%d %%  temperature %s%d.%d C\r\n", h10 / 10, h10 % 10, t10 < 0 ? "-" : "",
             (t10 < 0 ? -t10 : t10) / 10, (t10 < 0 ? -t10 : t10) % 10);
    }
    HAL_Delay(2000);
  }
}

static void MX_TIM2_Init(void)
{
  TIM_IC_InitTypeDef sConfigIC = {0};
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 0xFFFFFFFF;
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_IC_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigIC.ICPolarity = TIM_INPUTCHANNELPOLARITY_BOTHEDGE;
  sConfigIC.ICSelection = TIM_ICSELECTION_DIRECTTI;
  sConfigIC.ICPrescaler = TIM_ICPSC_DIV1;
  sConfigIC.ICFilter = 0;
  if (HAL_TIM_IC_ConfigChannel(&htim2, &sConfigIC, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_IC_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    __HAL_RCC_TIM2_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_3, GPIO_PIN_SET);
    data_pin(GPIO_MODE_AF_OD);
    HAL_NVIC_SetPriority(TIM2_IRQn, 0, 0);
    HAL_NVIC_EnableIRQ(TIM2_IRQn);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOC_CLK_ENABLE();
  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);
}

static void MX_USART2_UART_Init(void)
{
  huart2.Instance = USART2;
  huart2.Init.BaudRate = 115200;
  huart2.Init.WordLength = UART_WORDLENGTH_8B;
  huart2.Init.StopBits = UART_STOPBITS_1;
  huart2.Init.Parity = UART_PARITY_NONE;
  huart2.Init.Mode = UART_MODE_TX_RX;
  huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart2.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart2) != HAL_OK)
  {
    Error_Handler();
  }
}
