# SPRINT CSC-01 — Separação do CSC por empresa e ambiente

## 1. Causa raiz corrigida

A NFC-e lia um único `token_csc` / `id_csc` da configuração da empresa. Um salvamento sem segredo novo preservava o token anterior. Não havia CSC distinto para homologação (`tpAmb=2`) e produção (`tpAmb=1`), nem vínculo com o CNPJ. ID vazio passava por `Number` e virava `1` no QR Code. A rejeição `cStat=464` é consequência do segredo ou do identificador usado no hash, não da fórmula SHA-1.

A emissão da empresa agora usa somente o par do ambiente efetivo, e somente se `csc_cnpj_vinculado` for o CNPJ atual da empresa.

## 2. Arquivos alterados

- `backend/services/fiscal/empresasConfiguracaoFiscal.js` — colunas, validação, seleção e DTO sem segredo.
- `backend/services/fiscal/FiscalConfigUrlsResolver.js` — placeholder também nos campos por ambiente.
- `backend/services/fiscal/FiscalEmpresaContextoService.js` — bloqueio `CSC_NAO_CONFIGURADO_PARA_AMBIENTE`.
- `backend/services/fiscal/qrcode.js` — ID vazio ou inválido não entra no hash. A concatenação SHA-1 permanece `chave|2|tpAmb|idToken` + CSC.
- `backend/services/empresas/EmpresaService.js` — troca de CNPJ invalida os CSCs na mesma transação.
- `backend/observabilidade/eventSanitizer.js` — novos nomes de token entram na máscara de log.
- `frontend/erp/js/gestao-empresas-fiscal.js` — o campo único de ID e token segue o ambiente selecionado. O token não volta para a tela. Homologação e produção continuam gravados separados.
- `tests/fiscal/csc-por-empresa-ambiente.test.js` — cenários desta sprint.
- `tests/fiscal/fiscal-qrcode.test.js` — ID vazio não assume 1.
- Ajustes de expectativa nos testes que liam o CSC único como “configurado”.

Não houve alteração de recomposição, classificação de pagamento, quantidade, fórmula de fechamento nem do gerador além da recusa de credencial incompleta.

## 3. Migration e compatibilidade

Não há arquivo de migration separado. `garantirSchemaFiscalEmpresaAsync` acrescenta, se faltarem:

- `id_csc_homologacao`
- `token_csc_homologacao`
- `id_csc_producao`
- `token_csc_producao`
- `csc_cnpj_vinculado`

O `token_csc` antigo não é copiado para os dois ambientes. Na leitura da emissão ele não é usado. Uma gravação explícita do par antigo, com ID numérico, configura apenas o ambiente que está sendo salvo. ID não numérico permanece na coluna antiga e não habilita emissão.

Troca de CNPJ apaga, na mesma transação, os quatro campos novos, o vínculo e o par antigo. A resposta traz `cscs_invalidados` e a mensagem para cadastrar de novo.

Atualizar série, UF ou outro campo não apaga um CSC válido do mesmo CNPJ.

## 4. Regras de seleção

1. A empresa da venda continua sendo a dona da configuração. Não há fallback para o CSC global (`fiscal_token_csc`).
2. `tpAmb=2` lê só homologação. `tpAmb=1` lê só produção.
3. O vínculo `csc_cnpj_vinculado` tem de ser igual ao CNPJ da empresa.
4. O ID precisa ser inteiro positivo, sem espaços. Vazio não vira 1. `000007` vale 7.
5. Sem ID ou sem token do ambiente, a emissão para com `CSC_NAO_CONFIGURADO_PARA_AMBIENTE` ou `CSC_ID_INVALIDO`. O QR Code não é montado.
6. O DTO e a tela mostram “configurado” ou “não configurado” e, no máximo, o ID. O token não volta na API, no HTML nem no log de auditoria do QR.

## 5. Evidências dos testes

Banco em memória. Segredos sintéticos. Nenhuma transmissão à SEFAZ.

`node --test --test-concurrency=1 tests/fiscal/csc-por-empresa-ambiente.test.js`

13 testes, 0 falhas:

- homologação seleciona o CSC de homologação;
- produção seleciona o CSC de produção;
- homologação sem CSC bloqueia;
- produção sem CSC bloqueia;
- ID vazio, zero, com espaço ou texto bloqueia, sem assumir 1;
- token ausente bloqueia;
- CNPJ alterado zera a associação;
- série/UF preservam o CSC do mesmo CNPJ;
- duas empresas não misturam credenciais;
- CSC de homologação não serve em produção;
- CSC de produção não serve em homologação;
- tokens diferentes seguem o `tpAmb`;
- CSC antigo não numérico e CSC global não entram na emissão.

`node tests/fiscal/fiscal-qrcode.test.js` — 10 ok, 0 falhas. O caso `000001` continua gerando o ID `1` na fórmula já existente. ID vazio falha antes do hash.

Também passaram o cadastro de empresas (17/17), a suíte de máscara do CSC (13/13) e as telas de gestão fiscal ajustadas nesta sprint.

Falhas já existentes, fora desta correção: caminho de certificado `C:/certs/...` recusado pela proteção de 24/10/2026, e a suíte `isolamento-nfce-empresa-05-46` para em `preco_venda` ausente no schema daquele teste, antes do caso de CSC.

## 6. Confirmação de ausência de fallback

A configuração com `fonte=EMPRESA` não lê `fiscal_token_csc`. O token antigo sem vínculo de CNPJ devolve `tokenCSC` vazio. Homologação não preenche produção e produção não preenche homologação. Credencial incompleta não gera QR Code.

## 7. Pendências de configuração operacional

Depois que este código estiver em execução, cada empresa precisa cadastrar de novo:

- CSC de homologação (ID e token);
- CSC de produção (ID e token).

O processo que já estava aberto não carrega esta correção até ser reiniciado. Não emitir NFC-e antes de conferir os dois CSCs oficiais. A tela global antiga não alimenta a emissão da empresa.

Troca de CNPJ exige o mesmo cadastramento. A tela avisa que os CSCs anteriores foram invalidados.

## 8. Resultado

| Estado | Situação |
|---|---|
| CONCLUÍDO | Separação por empresa e ambiente, invalidação na troca de CNPJ, bloqueio sem CSC e ID vazio sem valor 1. |
| TESTADO | Testes automatizados desta sprint aprovados em banco temporário, com segredo sintético. |
| HOMOLOGADO | Não. Nenhuma NFC-e foi enviada à SEFAZ. |
| BLOQUEADO | Uso operacional, até o cadastramento e a conferência dos CSCs oficiais de homologação e de produção. |
