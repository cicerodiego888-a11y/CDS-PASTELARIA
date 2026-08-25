# MATRIZ VISUAL — PDV LEGADO vs PDV UNIVERSAL

**Sprint:** 05.19.1  
**Regra:** aproveitar experiência visual do legado. **Não** copiar `pdv.html` inteiro. Manter arquitetura Universal.

| Componente | PDV legado | PDV Universal | Melhor referência | Reaproveitável | Reescrever | Descartar |
|------------|------------|---------------|-------------------|----------------|------------|-----------|
| Densidade operacional | Alta: busca + tabela + resumo + chips | Média: cards soltos, poucos dados | **Legado** | Padrão de grid 2 colunas | CSS Universal | Layout “vazio / tutorial” como tela principal |
| Header marca + subtítulo | `CDS SISTEMAS` / Frente de Caixa | `PDV UNIVERSAL` + modo | **Legado** (hierarquia) + **Universal** (modo/empresa) | Tipografia / faixa | Header Universal para incluir status | Link permanente “PDV legado” (após unificação) |
| Operador | `#operadorPdv` | `#pdvu-operador` | Empate | Texto | — | — |
| Data/hora | Relógio `#dataHoraPdv` | Ausente | **Legado** | Widget relógio | — | — |
| Status caixa + Fechar | Chip + botão F7 | Ausente | **Legado** | Visual do chip | Ligar a APIs caixa existentes | Não inventar status fake |
| Calculadora | Botão + flutuante | Ausente | **Legado** | HTML/CSS calc | Isolar em widget Universal | — |
| Aparência / temas | F11 | Ausente | **Legado** (opcional) | `pdv-themes.css` ideias | Painel em CSS Universal | Não portar theme-manager como dependência de venda |
| Menu / sidebar | Sidebar completa + hamburger | Links ERP/legado no header | **Misto** | Ícones/ações | Shell Universal com drawer | Duplicar ERP inteiro dentro do PDV |
| Faixa sistema fiscal | `#faixaSistemaFiscalPdv` | Só “Modo:” | **Legado** (alerta) + **Universal** (modo oficial) | Faixa off/on | Binding em `modoFiscalHelpers` | Faixa se for só cosmética sem modo real |
| Busca | Label + input + botão + dropdown | Input único | **Legado** | Label PLU/barras, dropdown | Eventos → cart Universal | Handler jQuery de `pdv.js` |
| Tabela itens | 8 colunas (qtd, UN, desc, totais) | Linhas resumidas | **Legado** | Colunas e densidade | Bind em `PdvUniversalCart` | Edição de preço no cliente sem motor |
| Painel resumo | Subtotal, atacado, itens, desc, acréscimo, TOTAL grande | ITENS + TOTAL + select forma | **Legado** (hierarquia TOTAL) | Classes `total-pdv`, linhas | Inputs → payload checkout/MUV | Cálculo fiscal local como fonte da verdade |
| TOTAL destaque | Bloco grande | `pdvu-total` | **Legado** | Tipografia | — | — |
| Botão finalizar | Grande, F10, ícone | `FINALIZAR ATENDIMENTO` | **Legado** (presença) + **Universal** (copy correto) | Tamanho/atalho visual | Click → checkout oficial | Disparo direto `/api/vendas` |
| Botão entrega F9 | Secundário, módulo | Ausente | **Legado** (quando módulo on) | Estilo botão | Fluxo MUV/VAS futuro | Endpoint paralelo |
| Cancelar ESC | Botão visível | Só ESC em modal | **Legado** | Botão sempre visível | Cancelar atendimento API | ESC que limpa venda paga |
| Chip atalhos rodapé | F1–F11 + ESC | Uma linha de texto | **Legado** | Chips; **mapa oficial Universal** | Só atalhos sem conflito | Restaurar F7=peso (nunca existiu) |
| Modal pagamento | Rico (TEF, PIX, prazo, misto) | Modal unificado simples | **Universal** (arquitetura) + **Legado** (completude UX) | Layout de linhas | Integrar TEF/PIX oficiais | Segundo modal de venda |
| Modal empresa | Seletor sidebar | Modais oficiais | **Universal** | — | — | Seletor legado como fonte fiscal |
| Loading / erro contexto | Spinner página | Estados LOADING/ERROR/409 | **Universal** | — | — | — |
| Comprovante | Cupom + MUV opcional | iframe oficial | **Universal** | — | — | HTML de cupom paralelo |
| Responsividade | `d-none d-lg`, fullscreen `pdv-mode` | Cards empilháveis | **Misto** | Breakpoints legado | CSS Universal | Sidebar fixa em mobile sem drawer |
| Indicadores footer (entregas) | Widgets | Ausente | **Legado** (se módulo on) | Chips | APIs entregas existentes | Polling novo |

## Princípio visual da unificação

```
Experiência visual madura do legado
        +
Estados e pipeline do Universal
        =
Único PDV (sem terceiro HTML de venda)
```

Reescrever significa: **novos bindings** em `pdv-universal.js` / CSS Universal.  
Descartar significa: **não** transplantar o monolito `pdv.js`.
