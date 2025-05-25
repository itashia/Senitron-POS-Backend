import { Inject, Injectable } from "@tsed/di";
import { NotFound } from "@tsed/exceptions";
import { MYSQL_DATA_SOURCE } from "src/config/DataSources/MysqlDatasource.js";
import { ScanMode } from "src/enums/ScanMode.js";
import { Cart } from "src/models/Cart.js";
import { Device } from "src/models/Device.js";
import { Shop } from "src/models/Shop.js";
import { DataSource, Repository } from "typeorm";
import { EpcService } from "./EpcService.js";

type DeviceCreateParams = Partial<Device> & { tenant: string; deviceName: string };
type FindOrCreateParams = { deviceId: string; deviceName: string; tenant: string };
type ScanParams = { apiKey: string; epc: string; deviceId: string };
type BulkScanParams = { apiKey: string; epcs: string[]; deviceId: string };

@Injectable()
export class DeviceService {
  private deviceRepo: Repository<Device>;
  private shopRepository: Repository<Shop>;
  private cartRepository: Repository<Cart>;

  constructor(
    @Inject(MYSQL_DATA_SOURCE)
    private readonly dataSource: DataSource,
    @Inject(EpcService)
    private readonly epcService: EpcService
  ) {
    if (!this.dataSource) throw new Error("DataSource is undefined!");
    
    this.deviceRepo = this.dataSource.getRepository(Device);
    this.shopRepository = this.dataSource.getRepository(Shop);
    this.cartRepository = this.dataSource.getRepository(Cart);
  }

  async create(data: DeviceCreateParams): Promise<Device> {
    const shop = await this.shopRepository.findOneBy({ tenant: data.tenant });
    if (!shop) throw new NotFound(`Shop with tenant ${data.tenant} not found`);

    const cart = await this.cartRepository.save(this.cartRepository.create());
    const device = await this.deviceRepo.save(
      this.deviceRepo.create({
        ...data,
        name: data.deviceName,
        shop,
        cart
      })
    );

    this.logDeviceAction(device, `Created Device`);
    return device;
  }

  async update(id: string, updates: Partial<Device>): Promise<Device> {
    const device = await this.findById(id);
    Object.assign(device, updates);
    return this.deviceRepo.save(device);
  }

  async findById(id: string): Promise<Device> {
    const device = await this.deviceRepo.findOne({
      where: { id },
      relations: { shop: true, cart: true }
    });
    if (!device) throw new NotFound(`Device with id ${id} not found`);
    return device;
  }

  async findOrCreateByDeviceId(params: FindOrCreateParams): Promise<Device> {
    let device = await this.deviceRepo.findOne({
      where: { deviceId: params.deviceId },
      relations: { shop: true, cart: true }
    });

    if (!device) {
      return this.create(params);
    }

    const shop = await this.shopRepository.findOne({ where: { tenant: params.tenant } });
    if (shop) {
      device.shop = shop;
      device.name = params.deviceName;
      await this.deviceRepo.save(device);
    }

    return device;
  }

  async findByDeviceId(deviceId: string): Promise<Device> {
    const device = await this.deviceRepo.findOne({
      where: { deviceId },
      relations: { shop: true, cart: true }
    });
    
    if (!device) throw new NotFound(`Device with deviceId ${deviceId} not found`);
    this.logDeviceAction(device, `Found Device`);
    return device;
  }

  async getCartById(id: string): Promise<Cart> {
    const device = await this.findById(id);
    return this.getDeviceCart(device);
  }

  async getCartByDeviceId(deviceId: string): Promise<Cart> {
    const device = await this.findByDeviceId(deviceId);
    return this.getDeviceCart(device);
  }

  async scan(params: ScanParams): Promise<Cart> {
    const { deviceId, epc, apiKey } = params;
    const device = await this.findByDeviceId(deviceId);
    const cart = await this.getDeviceCart(device);
    const productData = await this.decodeEpc(epc, apiKey, device.shop.tenant);

    const updatedCart = cart.mode === ScanMode.REMOVE
      ? this.removeProductFromCartData(cart, productData.epc)
      : this.addProductToCartData(cart, productData);

    await this.cartRepository.save(updatedCart);
    this.logDeviceAction(device, `Scanned product with EPC ${epc} in ${cart.mode} mode`);
    return updatedCart;
  }

  async bulkScan(params: BulkScanParams): Promise<Cart> {
    const { deviceId, epcs, apiKey } = params;
    const device = await this.findByDeviceId(deviceId);
    const cart = await this.getDeviceCart(device);
    const tenant = device.shop.tenant;

    const productDataList = await Promise.all(
      epcs.map(epc => this.decodeEpc(epc, apiKey, tenant))
    );

    const updatedCart = cart.mode === ScanMode.REMOVE
      ? this.removeProductsFromCartData(cart, productDataList.map(p => p.epc))
      : this.addProductsToCartData(cart, productDataList);

    await this.cartRepository.save(updatedCart);
    this.logDeviceAction(device, `Bulk scanned ${epcs.length} products in ${cart.mode} mode`);
    return updatedCart;
  }

  async changeCartScanMode(deviceId: string, mode: ScanMode): Promise<Cart> {
    const device = await this.findByDeviceId(deviceId);
    const cart = await this.getDeviceCart(device);
    cart.mode = mode;
    
    await this.cartRepository.save(cart);
    this.logDeviceAction(device, `Changed cart mode to ${mode}`);
    return cart;
  }

  async removeProductFromCart(deviceId: string, serial: string): Promise<Cart> {
    const device = await this.findByDeviceId(deviceId);
    const cart = await this.getDeviceCart(device);
    
    const updatedCart = this.removeProductFromCartData(cart, serial, 'serial_number');
    await this.cartRepository.save(updatedCart);
    
    this.logDeviceAction(device, `Removed product with serial ${serial} from cart`);
    return updatedCart;
  }

  async emptyCart(deviceId: string): Promise<Cart> {
    const device = await this.findByDeviceId(deviceId);
    const cart = await this.getDeviceCart(device);
    
    cart.data = { products: [] };
    await this.cartRepository.save(cart);
    
    this.logDeviceAction(device, `Emptied cart`);
    return cart;
  }

  private async getDeviceCart(device: Device): Promise<Cart> {
    if (!device.cart) throw new NotFound(`Cart not found for device ${device.id}`);
    return device.cart;
  }

  private async decodeEpc(epc: string, apiKey: string, tenant: string) {
    return this.epcService.decode({ epc, apiKey, tenant });
  }

  private logDeviceAction(device: Device, action: string) {
    console.log(`${action} -> Tenant: ${device.shop?.tenant} -> Device: ${device.name} (${device.deviceId})`);
  }

  private getCartProducts(cart: Cart) {
    return Array.isArray(cart.data?.products) ? [...cart.data.products] : [];
  }

  private addProductToCartData(cart: Cart, productData: any): Cart {
    const products = this.getCartProducts(cart);
    const exists = products.some((p: { epc: string }) => p.epc === productData.epc);
    
    if (!exists) {
      products.push(productData);
      cart.data = { products };
    }
    
    return cart;
  }

  private addProductsToCartData(cart: Cart, productDataList: any[]): Cart {
    const products = this.getCartProducts(cart);
    const newProducts = productDataList.filter(
      newProduct => !products.some((p: { epc: string }) => p.epc === newProduct.epc)
    );
    
    if (newProducts.length > 0) {
      cart.data = { products: [...products, ...newProducts] };
    }
    
    return cart;
  }

  private removeProductFromCartData(cart: Cart, identifier: string, field: string = 'epc'): Cart {
    const products = this.getCartProducts(cart);
    const updatedProducts = products.filter(
      (product: any) => product[field] !== identifier
    );
    
    cart.data = { products: updatedProducts };
    return cart;
  }

  private removeProductsFromCartData(cart: Cart, epcs: string[]): Cart {
    const products = this.getCartProducts(cart);
    const epcSet = new Set(epcs);
    const updatedProducts = products.filter(
      (product: { epc: string }) => !epcSet.has(product.epc)
    );
    
    cart.data = { products: updatedProducts };
    return cart;
  }
}
