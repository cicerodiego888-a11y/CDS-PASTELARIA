# Relatório — Sprint 05.01

## Fundação do PDV Universal

### 1. Arquivos auditados

`VendaApplicationService`, `configuracaoService`, `motores/muv`, `rotas/vendas`, `rotas/empresas`, `rotas/atendimentos`, `server.js`, `EmpresaService`, `empresaContexto`.

### 2. Arquivos criados

- `backend/motores/pdv-universal/PDVUniversalApplicationService.js`
- `backend/motores/pdv-universal/contratos.js`
- `backend/motores/pdv-universal/contexto/resolverContextoOperacional.js`
- `backend/motores/pdv-universal/adaptadores/EmpresaUnicaAdapter.js`
- `backend/motores/pdv-universal/adaptadores/MultiempresaAdapter.js`
- `backend/rotas/pdv-universal.js`
- `tests/pdv-universal/fundacao-pdv-universal-05-01.test.js`
- `docs/arquitetura/IMPLEMENTACAO_05_01_FUNDACAO_PDV_UNIVERSAL.md`
- `docs/arquitetura/IMPLEMENTACAO_05_01_RELATORIO.md`

### 3. Arquivos alterados

- `backend/server.js` — monta `GET /api/pdv-universal` com `verificarToken`
- `docs/arquitetura/ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md` — roadmap 05.01

### 4. Contrato oficial

Contexto + capacidades + integração (porta EMPRESA_UNICA vs MUV). Capabilities derivadas do modo, não flags de frontend.

### 5. Fluxo EMPRESA_UNICA

Adaptador → `VendaApplicationService.criarVenda`. `criaAtendimento: false`. Recusado se o modo ativo for MULTIEMPRESA.

### 6. Fluxo MULTIEMPRESA

Adaptador reconhece o MUV (`criar/reservar/pagar/materializar/fiscalizar`). Não cai no legado. Não implementa checkout nesta sprint.

### 7. Endpoint

`GET /api/pdv-universal/contexto` — não altera estado, não expõe CSC/PFX/senha.

### 8. Compatibilidade com o PDV atual

Rotas, atalhos e `POST /api/vendas` intactos.

### 9. Testes novos

`fundacao-pdv-universal-05-01` — **15/15**

### 10. Regressão

04.01–04.14 e 05.01: **OK**. Críticos (MUC, VendaApplication, Orquestrador, TEF, dual-write, reservas, saldo, Pedido/MTS, expedição, compras, baixa, cancel/devolução/revert): **OK**.

### 11. Falhas pré-existentes

Nenhuma introduzida por esta sprint. Falhas antigas de outros módulos (se existirem fora desta suíte) não foram mascaradas.

### 12. Limitações

Sem UI, sem seletor de empresa, sem rotas de reserva/pagamento/fiscalizar, sem ESC/POS.

### 13. Recomendação para a 05.02 (não iniciada)

Aprofundar contexto operacional: seleção de empresa, operador, empresas disponíveis no PDV Universal — consumindo `GET /api/pdv-universal/contexto` e as APIs de empresas já existentes. Sem novo motor.
