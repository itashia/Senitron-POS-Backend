import { Service } from "@tsed/di";
import { BadRequest } from "@tsed/exceptions";
import { Product } from "src/models/Product.js";
import { Logger } from "@tsed/logger";

type DecodeEpcParams = {
  tenant: string;
  apiKey: string | undefined;
  epc: string;
};

@Service()
export class SenitronAPI {
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor() {
    this.baseUrl = this.validateBaseUrl();
    this.logger = new Logger(SenitronAPI.name);
  }

  async decodeEpc(params: DecodeEpcParams): Promise<Product> {
    this.validateApiKey(params.apiKey);
    
    const url = this.buildRequestUrl(params);
    this.logger.debug(`Sending request to Senitron API: ${url}`);

    try {
      const response = await this.fetchWithTimeout(url);
      this.validateResponse(response, params);
      
      const data = await response.json();
      return new Product(data);
    } catch (error) {
      this.logger.error(`Error decoding EPC: ${params.epc}`, error);
      throw this.normalizeError(error, params);
    }
  }

  private validateBaseUrl(): string {
    const baseUrl = process.env.SENITRON_API_BASE_URL?.replace("{tenant}", "");
    if (!baseUrl) {
      throw new Error("SENITRON_API_BASE_URL environment variable is not properly configured");
    }
    return baseUrl;
  }

  private validateApiKey(apiKey: string | undefined): void {
    if (!apiKey) {
      throw new BadRequest("API key is required");
    }
  }

  private buildRequestUrl(params: DecodeEpcParams): string {
    const { tenant, apiKey, epc } = params;
    const encodedEpc = encodeURIComponent(epc);
    return `${this.baseUrl.replace("{tenant}", tenant)}/epcs/decode?api_key=${apiKey}&epc=${encodedEpc}&item_details=true`;
  }

  private async fetchWithTimeout(url: string, timeout: number = 5000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  private validateResponse(response: Response, params: DecodeEpcParams): void {
    if (!response.ok) {
      throw new BadRequest(
        `Senitron API request failed with status ${response.status}: ${response.statusText}. ` +
        `Request details: tenant=${params.tenant}, epc=${params.epc}`
      );
    }
  }

  private normalizeError(error: unknown, params: DecodeEpcParams): Error {
    if (error instanceof BadRequest) {
      return error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      return new BadRequest(`Request to Senitron API timed out for EPC: ${params.epc}`);
    }

    return new BadRequest(
      `Failed to decode EPC: ${params.epc}. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
